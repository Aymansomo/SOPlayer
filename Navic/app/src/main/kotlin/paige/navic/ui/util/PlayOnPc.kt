/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import org.koin.compose.koinInject
import paige.navic.R
import paige.navic.domain.manager.ui.SnackBarManager
import paige.navic.domain.model.DomainSong
import paige.navic.domain.repository.RemoteRepository
import paige.navic.domain.repository.RemoteResult

/**
 * "Play on PC": hands songs to the desktop player over the remote API, so the
 * phone can decide what plays on the computer instead of only pausing it.
 * Returns a function taking the songs and the index to start at.
 *
 * The request runs on the repository's own scope: every caller dismisses its
 * sheet right after tapping, and a scope tied to that composable would be
 * cancelled before the command reached the PC.
 */
@Composable
fun rememberPlayOnPc(): (List<DomainSong>, Int) -> Unit {
	val repository = koinInject<RemoteRepository>()
	val snackBarManager = koinInject<SnackBarManager>()
	return remember(repository, snackBarManager) {
		{ songs: List<DomainSong>, startIndex: Int ->
			repository.playOnPcInBackground(songs, startIndex) { result ->
				when (result) {
					is RemoteResult.Success -> snackBarManager.notify(R.string.notice_playing_on_pc)
					RemoteResult.NeedLogin -> snackBarManager.notify(R.string.notice_pc_needs_login)
					is RemoteResult.Failure -> snackBarManager.notify(R.string.notice_pc_unreachable)
				}
			}
			Unit
		}
	}
}
