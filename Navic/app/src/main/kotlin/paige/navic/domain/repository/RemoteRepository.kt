/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.domain.repository

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import paige.navic.domain.manager.session.SessionManager
import paige.navic.domain.model.DomainSong
import paige.navic.util.network.createHttpClient

@Serializable
data class RemoteTrack(
	val title: String = "",
	val artist: String = "",
	val album: String = "",
	val thumbnail: String = "",
	val duration: Double = 0.0,
	val platform: String = ""
)

@Serializable
data class RemotePlaybackState(
	val track: RemoteTrack? = null,
	val playing: Boolean = false,
	val position: Double = 0.0,
	val duration: Double = 0.0,
	val volume: Double = 0.0,
	val muted: Boolean = false,
	val liked: Boolean = false,
	val updatedAt: Long = 0,
	val canControl: Boolean = false
)

@Serializable
data class RemoteStateEnvelope(
	val ok: Boolean = false,
	val remoteEnabled: Boolean = true,
	val canControl: Boolean = false,
	val stale: Boolean = false,
	val needLogin: Boolean = false,
	val state: RemotePlaybackState? = null,
	val error: String? = null
)

sealed interface RemoteResult {
	data class Success(val envelope: RemoteStateEnvelope) : RemoteResult
	data object NeedLogin : RemoteResult
	data class Failure(val message: String) : RemoteResult
}

/**
 * Talks to the desktop player's phone remote API (the `/remote/api` endpoints)
 * over the music server address this account is already signed in to, so the
 * user never has to type their password a second time.
 */
class RemoteRepository(
	private val sessionManager: SessionManager
) {
	private companion object {
		const val COOKIE_NAME = "riff_remote"
	}

	private val client: HttpClient = createHttpClient()
	private val json = Json {
		ignoreUnknownKeys = true
		isLenient = true
		explicitNulls = false
	}
	private val mutex = Mutex()
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

	private var cookie: String? = null
	private var sessionBase: String? = null

	private fun baseUrl(): String = sessionManager.instanceUrl.trim().trimEnd('/')

	private suspend fun send(url: String, path: String, payload: String?): HttpResponse {
		val token = cookie
		return if (payload == null) {
			client.get("$url/remote/api/$path") {
				token?.let { header(HttpHeaders.Cookie, it) }
			}
		} else {
			client.post("$url/remote/api/$path") {
				token?.let { header(HttpHeaders.Cookie, it) }
				contentType(ContentType.Application.Json)
				setBody(payload)
			}
		}
	}

	private suspend fun loginLocked(url: String): Boolean {
		cookie = null
		val response = try {
			client.post("$url/remote/api/login") {
				contentType(ContentType.Application.Json)
				setBody(
					buildJsonObject {
						put("username", sessionManager.username)
						put("password", sessionManager.password)
					}.toString()
				)
			}
		} catch (_: Exception) {
			return false
		}
		if (!response.status.isSuccess()) return false
		val setCookie = response.headers.getAll(HttpHeaders.SetCookie)
			?.firstOrNull { it.startsWith("$COOKIE_NAME=") }
		cookie = setCookie?.substringBefore(';')
			?.takeIf { it.length > COOKIE_NAME.length + 1 }
		return cookie != null
	}

	private suspend fun ensureLoggedIn(): Boolean {
		val url = baseUrl()
		if (url.isBlank()) return false
		if (sessionBase != url) {
			sessionBase = url
			cookie = null
		}
		if (cookie != null) return true
		return mutex.withLock {
			if (cookie != null) true else loginLocked(url)
		}
	}

	private suspend fun call(path: String, payload: String?): RemoteResult {
		val url = baseUrl()
		if (url.isBlank()) {
			return RemoteResult.Failure("No music server address is configured")
		}
		if (!ensureLoggedIn()) return RemoteResult.NeedLogin

		var response = try {
			send(url, path, payload)
		} catch (e: Exception) {
			return RemoteResult.Failure(e.message ?: "Riff is not reachable")
		}

		if (response.status.value == 401) {
			val relogged = mutex.withLock {
				cookie = null
				loginLocked(url)
			}
			if (!relogged) return RemoteResult.NeedLogin
			response = try {
				send(url, path, payload)
			} catch (e: Exception) {
				return RemoteResult.Failure(e.message ?: "Riff is not reachable")
			}
		}

		val envelope = try {
			json.decodeFromString<RemoteStateEnvelope>(response.bodyAsText())
		} catch (_: Exception) {
			null
		}

		if (response.status.value == 401) return RemoteResult.NeedLogin
		if (!response.status.isSuccess()) {
			return RemoteResult.Failure(
				envelope?.error ?: "Riff returned HTTP ${response.status.value}"
			)
		}
		if (envelope == null) return RemoteResult.Failure("Unexpected response from Riff")
		return RemoteResult.Success(envelope)
	}

	suspend fun connect(): Boolean = ensureLoggedIn()

	suspend fun getState(): RemoteResult = call("state", null)

	suspend fun sendCommand(action: String, value: Double? = null): RemoteResult = call(
		path = "command",
		payload = buildJsonObject {
			put("action", action)
			if (value != null) put("value", value)
		}.toString()
	)

	/**
	 * Ask the desktop to play [songs], starting at [startIndex]. Only the ids are
	 * authoritative — the desktop resolves them against its own library and
	 * online cache — the rest travels along so the now-playing card is right even
	 * if the PC has to skip an id it does not know.
	 */
	suspend fun playOnPc(songs: List<DomainSong>, startIndex: Int = 0): RemoteResult {
		if (songs.isEmpty()) return RemoteResult.Failure("Nothing to play")
		return call(
			path = "command",
			payload = buildJsonObject {
				put("action", "playtracks")
				put("index", startIndex.coerceAtLeast(0))
				put("tracks", buildJsonArray {
					songs.forEach { song ->
						add(
							buildJsonObject {
								put("id", song.id)
								put("title", song.title)
								put("artist", song.artistName.orEmpty())
								put("album", song.albumTitle.orEmpty())
								put("duration", song.duration.inWholeSeconds.toDouble())
							}
						)
					}
				})
			}.toString()
		)
	}

	/**
	 * [playOnPc] for UI callbacks that outlive the calling composable: the song
	 * sheet is dismissed as soon as the row is tapped, which would cancel a
	 * `rememberCoroutineScope` coroutine before the request leaves the phone.
	 */
	fun playOnPcInBackground(
		songs: List<DomainSong>,
		startIndex: Int = 0,
		onResult: (RemoteResult) -> Unit
	) {
		scope.launch { onResult(playOnPc(songs, startIndex)) }
	}
}
