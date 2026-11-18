/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.domain.model

import androidx.annotation.StringRes
import androidx.compose.runtime.Immutable
import kotlinx.serialization.Serializable
import paige.navic.R

/**
 * How the songs of a playlist are listed.
 *
 * `PlaylistOrder` is the server's own order (the order songs were added),
 * so `RecentlyAdded` — the same order reversed — is "the last song added to
 * the playlist comes first".
 */
@Serializable
@Immutable
enum class DomainPlaylistSongSort(@StringRes val displayName: Int) {
	PlaylistOrder(R.string.option_sort_playlist_order),
	RecentlyAdded(R.string.option_sort_newest),
	Title(R.string.option_sort_title),
	Artist(R.string.option_sort_artist),
	Album(R.string.option_sort_album),
	Duration(R.string.option_sort_playlist_duration)
}
