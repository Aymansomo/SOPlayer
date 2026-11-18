/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import paige.navic.playback.MediaPlayer

/**
 * Only what a song row draws about playback.
 *
 * Rows used to collect the whole [paige.navic.ui.core.PlayerUiState], which the
 * progress loop rewrites five times a second while something plays, so every
 * visible row (and its marquee text, cover art and badge row) recomposed five
 * times a second. Mapping to this pair and dropping duplicates means a row only
 * recomposes when it becomes (or stops being) the current song, or when
 * play/pause changes.
 */
data class SongPlaybackState(
	val isCurrent: Boolean = false,
	val isPaused: Boolean = true
)

@Composable
fun rememberSongPlaybackState(player: MediaPlayer, songId: String): State<SongPlaybackState> =
	remember(player, songId) {
		player.uiState
			.map { state ->
				SongPlaybackState(
					isCurrent = state.currentSong?.id == songId,
					isPaused = state.isPaused
				)
			}
			.distinctUntilChanged()
	}.collectAsStateWithLifecycle(initialValue = SongPlaybackState())
