/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.domain.manager.runtime

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import paige.navic.util.Logger
import paige.navic.util.xxHash32
import java.io.File

/**
 * Playlist cover images chosen on the device.
 *
 * Subsonic has no way to store a cover for a playlist, so the image picked by
 * the user is kept in the app's files and drawn instead of the artwork the
 * server would return.
 */
class PlaylistArtworkManager(
	private val context: Context
) {
	private val artworkDirectory: File
		get() = File(context.filesDir, "playlist-artwork")

	/** Bumped whenever an image is set or removed so covers can be redrawn. */
	private val _revision = MutableStateFlow(0)
	val revision: StateFlow<Int> = _revision.asStateFlow()

	private fun artworkPath(playlistId: String): File =
		File(artworkDirectory, "${playlistId.xxHash32()}.img")

	fun getArtwork(playlistId: String): File? =
		artworkPath(playlistId).takeIf { it.isFile && it.length() > 0 }

	suspend fun setArtwork(playlistId: String, uri: Uri): Boolean = withContext(Dispatchers.IO) {
		val directory = artworkDirectory.apply { mkdirs() }
		val target = artworkPath(playlistId)
		val temp = try {
			File.createTempFile(target.name, ".part", directory)
		} catch (e: Exception) {
			Logger.e("PlaylistArtworkManager", "couldn't create a temporary file", e)
			return@withContext false
		}
		try {
			val copied = context.contentResolver.openInputStream(uri)?.use { input ->
				temp.outputStream().use { output -> input.copyTo(output) }
				true
			} ?: false
			if (!copied || temp.length() == 0L) {
				temp.delete()
				return@withContext false
			}
			if (target.exists()) target.delete()
			val renamed = temp.renameTo(target)
			if (!renamed) temp.delete()
			if (renamed) _revision.value++
			renamed
		} catch (e: Exception) {
			temp.delete()
			Logger.e("PlaylistArtworkManager", "couldn't save playlist artwork", e)
			false
		}
	}

	fun clearArtwork(playlistId: String) {
		artworkPath(playlistId).delete()
		_revision.value++
	}
}
