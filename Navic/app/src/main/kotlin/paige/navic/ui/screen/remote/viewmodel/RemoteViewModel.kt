/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.screen.remote.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import paige.navic.domain.model.DomainPlaylist
import paige.navic.domain.repository.CollectionRepository
import paige.navic.domain.repository.PlaylistRepository
import paige.navic.domain.repository.RemoteRepository
import paige.navic.domain.repository.RemoteResult
import paige.navic.domain.repository.RemoteTrack

data class RemoteUiState(
	val isConnecting: Boolean = true,
	val connected: Boolean = false,
	val error: String? = null,
	val needsLogin: Boolean = false,
	val track: RemoteTrack? = null,
	val playing: Boolean = false,
	val position: Double = 0.0,
	val duration: Double = 0.0,
	val volume: Double = 0.0,
	val muted: Boolean = false,
	val liked: Boolean = false,
	val canControl: Boolean = false,
	val stale: Boolean = false,
	val remoteEnabled: Boolean = true,
	val playlists: List<DomainPlaylist> = emptyList(),
	val loadingPlaylists: Boolean = false,
	val playStatus: String? = null
)

class RemoteViewModel(
	private val repository: RemoteRepository,
	private val playlistRepository: PlaylistRepository,
	private val collectionRepository: CollectionRepository
) : ViewModel() {

	private val _state = MutableStateFlow(RemoteUiState())
	val state: StateFlow<RemoteUiState> = _state.asStateFlow()

	private var polling: Job? = null

	init {
		connect()
	}

	fun connect() {
		polling?.cancel()
		polling = viewModelScope.launch {
			_state.update { it.copy(isConnecting = true, error = null) }
			while (isActive) {
				when (val result = repository.getState()) {
					is RemoteResult.Success -> apply(result)
					RemoteResult.NeedLogin -> {
						_state.update {
							it.copy(
								isConnecting = false,
								connected = false,
								needsLogin = true,
								error = "Riff rejected the saved credentials. Remote control needs the same username and password as your music server."
							)
						}
						delay(5000)
					}
					is RemoteResult.Failure -> {
						_state.update {
							it.copy(
								isConnecting = false,
								connected = false,
								error = result.message
							)
						}
						delay(4000)
					}
				}
				delay(1200)
			}
		}
	}

	private fun apply(result: RemoteResult.Success) {
		val envelope = result.envelope
		val playback = envelope.state
		_state.update {
			it.copy(
				isConnecting = false,
				connected = true,
				needsLogin = false,
				error = null,
				remoteEnabled = envelope.remoteEnabled,
				stale = envelope.stale,
				canControl = envelope.canControl,
				track = playback?.track,
				playing = playback?.playing ?: false,
				position = playback?.position ?: 0.0,
				duration = playback?.duration ?: 0.0,
				volume = playback?.volume ?: 0.0,
				muted = playback?.muted ?: false,
				liked = playback?.liked ?: false
			)
		}
	}

	/** The PC cannot be browsed, so the phone offers its own playlists to send. */
	fun loadPlaylists() {
		if (_state.value.playlists.isNotEmpty() || _state.value.loadingPlaylists) return
		viewModelScope.launch {
			_state.update { it.copy(loadingPlaylists = true) }
			val playlists = runCatching { playlistRepository.getAllPlaylists() }
				.getOrDefault(emptyList())
				.sortedBy { playlist -> playlist.name.orEmpty().lowercase() }
			_state.update { it.copy(playlists = playlists, loadingPlaylists = false) }
		}
	}

	fun playPlaylistOnPc(playlist: DomainPlaylist) {
		viewModelScope.launch {
			_state.update { it.copy(playStatus = "Sending ${playlist.name.orEmpty()}…") }
			val songs = runCatching {
				collectionRepository.getPlaylistSongs(playlist.id)
			}.getOrDefault(emptyList())
			if (songs.isEmpty()) {
				_state.update {
					it.copy(playStatus = "${playlist.name.orEmpty()} has no songs to play")
				}
				return@launch
			}
			when (val result = repository.playOnPc(songs, 0)) {
				is RemoteResult.Success -> {
					apply(result)
					_state.update { it.copy(playStatus = "Playing ${playlist.name.orEmpty()} on the PC") }
				}

				is RemoteResult.Failure -> _state.update { it.copy(playStatus = result.message) }
				RemoteResult.NeedLogin -> _state.update {
					it.copy(
						needsLogin = true,
						playStatus = "Riff rejected the saved credentials"
					)
				}
			}
		}
	}

	fun command(action: String, value: Double? = null) {
		viewModelScope.launch {
			val result = repository.sendCommand(action, value)
			if (result is RemoteResult.Success) apply(result)
			else if (result is RemoteResult.Failure) {
				_state.update { it.copy(error = result.message) }
			}
		}
	}
}
