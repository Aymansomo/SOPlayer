/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.component.sheet

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.koin.compose.koinInject
import org.koin.compose.viewmodel.koinViewModel
import paige.navic.R
import paige.navic.domain.manager.runtime.PreferenceManager
import paige.navic.ui.component.common.Markdown
import paige.navic.ui.theme.defaultFont
import paige.navic.util.Logger
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

private const val RELEASES_URL =
	"https://api.github.com/repos/Aymansomo/SOPlayer/releases/latest"

private const val APK_FILE_NAME = "update.apk"

@Serializable
data class GitHubRelease(
	@SerialName("tag_name") val tag: String,
	@SerialName("body") val body: String = "",
	@SerialName("assets") val assets: List<GitHubReleaseAsset> = emptyList()
) {
	val version: String
		get() = tag.trim().removePrefix("v").removePrefix("V")

	val apkUrl: String?
		get() = assets.firstOrNull { it.name.endsWith(".apk", ignoreCase = true) }?.downloadUrl
}

@Serializable
data class GitHubReleaseAsset(
	@SerialName("name") val name: String,
	@SerialName("browser_download_url") val downloadUrl: String
)

internal data class AppVersion(
	val core: List<Int>,
	/** Pre-release identifiers, e.g. ["beta", 3]; empty for a final release. */
	val preRelease: List<Any>
)

/**
 * Parses "v1.0.0", "android-v1.0.2", "1.0.0-beta02" or "1.0.0-rc.1" so that
 * versions can be ordered properly instead of compared as strings.
 */
internal fun parseVersion(raw: String?): AppVersion? {
	if (raw.isNullOrBlank()) return null
	val match = Regex("""(\d+(?:\.\d+)*)(?:[-_.]?([0-9A-Za-z][0-9A-Za-z.\-]*))?""")
		.find(raw) ?: return null
	val core = match.groupValues[1]
		.split('.')
		.map { it.toIntOrNull() ?: 0 }
	val preRelease = PRERELEASE_TOKEN.findAll(match.groupValues[2])
		.map { token -> token.value.toIntOrNull() ?: token.value.lowercase() }
		.toList()
	return AppVersion(core, preRelease)
}

private val PRERELEASE_TOKEN = Regex("""[0-9]+|[A-Za-z]+""")

/** Orders two versions: negative if [a] is older, positive if newer, 0 if equal. */
internal fun compareVersions(a: AppVersion, b: AppVersion): Int {
	for (index in 0 until maxOf(a.core.size, b.core.size)) {
		val left = a.core.getOrElse(index) { 0 }
		val right = b.core.getOrElse(index) { 0 }
		if (left != right) return left.compareTo(right)
	}
	// A final release is newer than any pre-release of the same version.
	if (a.preRelease.isEmpty() && b.preRelease.isEmpty()) return 0
	if (a.preRelease.isEmpty()) return 1
	if (b.preRelease.isEmpty()) return -1
	for (index in 0 until maxOf(a.preRelease.size, b.preRelease.size)) {
		if (index >= a.preRelease.size) return -1
		if (index >= b.preRelease.size) return 1
		val left = a.preRelease[index]
		val right = b.preRelease[index]
		val comparison = when {
			left is Int && right is Int -> left.compareTo(right)
			left is Int -> -1 // numeric identifiers sort before words
			right is Int -> 1
			else -> (left as String).compareTo(right as String)
		}
		if (comparison != 0) return comparison
	}
	return 0
}

internal fun isNewerVersion(remote: String?, current: String?): Boolean {
	val remoteVersion = parseVersion(remote) ?: return false
	val currentVersion = parseVersion(current) ?: return true
	return compareVersions(remoteVersion, currentVersion) > 0
}

class ChangelogViewModel(
	private val context: Context
) : ViewModel() {
	val release: StateFlow<GitHubRelease?>
		field = MutableStateFlow(null)

	/** Progress in percent while downloading, null when idle. */
	val downloadProgress: StateFlow<Int?>
		field = MutableStateFlow(null)

	val errorMessage: StateFlow<String?>
		field = MutableStateFlow(null)

	// APK that is on disk already, so granting install permission does not
	// trigger a second download.
	private var pendingApk: File? = null

	private val updateClient = HttpClient {
		install(ContentNegotiation) {
			json(Json { ignoreUnknownKeys = true })
		}
	}

	init {
		checkForUpdates(
			context.packageManager
				.getPackageInfo(context.packageName, 0)
				.versionName.toString()
		)
	}

	fun checkForUpdates(currentVersion: String) {
		viewModelScope.launch {
			release.value = try {
				val response = updateClient.get(RELEASES_URL) {
					header("Accept", "application/vnd.github+json")
					header("User-Agent", "SOPlayer-Android-Updater")
				}
				// No releases yet (or rate-limited): nothing to offer.
				if (!response.status.isSuccess()) return@launch
				val latest: GitHubRelease = response.body()
				if (isNewerVersion(latest.version, currentVersion)) latest else null
			} catch (e: Exception) {
				// Offline or GitHub unreachable: stay quiet, the app keeps working.
				Logger.e("ChangelogViewModel", "couldn't check for updates", e)
				null
			}
		}
	}

	fun downloadAndInstall(release: GitHubRelease) {
		// Already downloaded and only the install permission was missing.
		pendingApk?.takeIf { it.exists() }?.let { apk ->
			installOrAskPermission(apk)
			return
		}
		val apkUrl = release.apkUrl
		if (apkUrl == null) {
			errorMessage.value = context.getString(R.string.error_update_no_apk)
			return
		}
		if (downloadProgress.value != null) return
		errorMessage.value = null
		viewModelScope.launch {
			downloadProgress.value = 0
			val apk = try {
				withContext(Dispatchers.IO) { downloadApk(apkUrl) }
			} catch (e: Exception) {
				Logger.e("ChangelogViewModel", "couldn't download update", e)
				errorMessage.value = context.getString(
					R.string.error_update_download,
					e.message ?: e.javaClass.simpleName
				)
				null
			} finally {
				downloadProgress.value = null
			}
			if (apk == null) return@launch
			pendingApk = apk
			installOrAskPermission(apk)
		}
	}

	/**
	 * Called when the screen comes back to the foreground (for example after the
	 * user allowed installs in system settings): installs the APK that is already
	 * in the cache without downloading it again.
	 */
	fun installPendingApkIfAllowed() {
		val apk = pendingApk ?: return
		if (!apk.exists()) {
			pendingApk = null
			return
		}
		if (downloadProgress.value != null) return
		if (!canInstallPackages()) return
		installOrAskPermission(apk)
	}

	private fun installOrAskPermission(apk: File) {
		errorMessage.value = null
		if (!canInstallPackages()) {
			requestInstallPermission()
			return
		}
		pendingApk = null
		startInstaller(apk)
	}

	fun clearRelease() {
		release.value = null
	}

	private fun downloadApk(url: String): File {
		val target = File(context.cacheDir, APK_FILE_NAME)
		if (target.exists()) target.delete()

		val connection = (URL(url).openConnection() as HttpURLConnection).apply {
			instanceFollowRedirects = true
			connectTimeout = 15_000
			readTimeout = 30_000
			setRequestProperty("User-Agent", "SOPlayer-Android-Updater")
		}
		try {
			if (connection.responseCode !in 200..299) {
				throw IllegalStateException("HTTP ${connection.responseCode}")
			}
			val total = connection.contentLengthLong
			connection.inputStream.use { input ->
				target.outputStream().use { output ->
					val buffer = ByteArray(64 * 1024)
					var copied = 0L
					while (true) {
						val read = input.read(buffer)
						if (read <= 0) break
						output.write(buffer, 0, read)
						copied += read
						if (total > 0) {
							downloadProgress.value = ((copied * 100) / total).toInt()
						}
					}
				}
			}
		} finally {
			connection.disconnect()
		}
		return target
	}

	private fun canInstallPackages(): Boolean =
		Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
			context.packageManager.canRequestPackageInstalls()

	private fun requestInstallPermission() {
		errorMessage.value = context.getString(R.string.error_update_permission)
		runCatching {
			context.startActivity(
				Intent(
					Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
					Uri.parse("package:${context.packageName}")
				).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			)
		}
	}

	private fun startInstaller(apk: File) {
		try {
			val uri = FileProvider.getUriForFile(
				context,
				"${context.packageName}.fileprovider",
				apk
			)
			val intent = Intent(Intent.ACTION_VIEW).apply {
				setDataAndType(uri, "application/vnd.android.package-archive")
				addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
				addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			}
			context.startActivity(intent)
		} catch (e: Exception) {
			Logger.e("ChangelogViewModel", "couldn't launch the installer", e)
			errorMessage.value = context.getString(
				R.string.error_update_download,
				e.message ?: e.javaClass.simpleName
			)
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangelogSheet() {
	val preferenceManager = koinInject<PreferenceManager>()
	val viewModel = koinViewModel<ChangelogViewModel>()
	val release by viewModel.release.collectAsStateWithLifecycle()
	val downloadProgress by viewModel.downloadProgress.collectAsStateWithLifecycle()
	val errorMessage by viewModel.errorMessage.collectAsStateWithLifecycle()
	val context = LocalContext.current

	// Covers the return from "install unknown apps": the cached APK is installed
	// straight away instead of being downloaded a second time.
	LifecycleResumeEffect(Unit) {
		viewModel.installPendingApkIfAllowed()
		onPauseOrDispose { }
	}

	release?.let { release ->
		ModalBottomSheet(
			onDismissRequest = { viewModel.clearRelease() },
			sheetState = rememberBottomSheetState(
				initialValue = SheetValue.Hidden,
				enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded)
			)
		) {
			Column(
				modifier = Modifier
					.fillMaxWidth()
					.verticalScroll(rememberScrollState())
					.padding(horizontal = 16.dp)
			) {
				Column(
					modifier = Modifier.fillMaxWidth(),
					horizontalAlignment = Alignment.CenterHorizontally
				) {
					Text(
						text = stringResource(R.string.title_update),
						style = MaterialTheme.typography.titleLarge,
						fontFamily = defaultFont(round = 100f)
					)
					Text(
						stringResource(R.string.info_update, release.tag),
						style = MaterialTheme.typography.bodyMedium
					)
				}

				Spacer(Modifier.height(8.dp))

				if (release.body.isNotBlank()) {
					Markdown(
						text = release.body,
						modifier = Modifier
							.heightIn(max = 400.dp)
							.fillMaxWidth()
							.clip(MaterialTheme.shapes.large)
							.background(MaterialTheme.colorScheme.surfaceContainerHigh)
							.verticalScroll(rememberScrollState())
							.padding(10.dp)
					)
				}

				Spacer(Modifier.height(8.dp))
				Spacer(Modifier.weight(1f))

				downloadProgress?.let { progress ->
					Text(
						text = stringResource(R.string.info_update_downloading, progress),
						style = MaterialTheme.typography.bodyMedium
					)
					Spacer(Modifier.height(8.dp))
				}

				errorMessage?.let { message ->
					Text(
						text = message,
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.error
					)
					Spacer(Modifier.height(8.dp))
				}

				if (downloadProgress == null) {
					Button(
						onClick = { viewModel.downloadAndInstall(release) },
						modifier = Modifier.fillMaxWidth(),
						shape = CircleShape
					) {
						Text(
							text = stringResource(R.string.action_update_app),
							fontFamily = defaultFont(100)
						)
					}
				} else {
					LinearProgressIndicator(
						progress = { (downloadProgress ?: 0) / 100f },
						modifier = Modifier.fillMaxWidth()
					)
				}

				OutlinedButton(
					onClick = {
						viewModel.clearRelease()
						preferenceManager.checkForUpdates = false
					},
					modifier = Modifier.fillMaxWidth(),
					shape = CircleShape
				) {
					Text(
						text = stringResource(R.string.action_dont_show_again),
						fontFamily = defaultFont(100)
					)
				}
			}
		}
	}
}
