/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.database.query

import androidx.room3.RoomRawQuery
import paige.navic.domain.model.DomainFilter
import paige.navic.domain.model.DomainPlaylistSongSort

/**
 * Songs of one playlist, ordered and filtered for the playlist detail screen.
 * `ps.position` is the order the server returns, which is the order songs were
 * added in, so it doubles as "when it was added to the playlist".
 */
fun DomainPlaylistSongSort.toSongQuery(
	playlistId: String,
	reversed: Boolean = false,
	filters: Set<DomainFilter> = emptySet(),
	idsOnly: Boolean = false
): RoomRawQuery {
	val whereClauses = mutableListOf("ps.playlistId = ?")
	val args = mutableListOf<Any>(playlistId)

	if (filters.contains(DomainFilter.Starred)) {
		whereClauses.add("s.starredAt IS NOT NULL")
	}

	if (filters.contains(DomainFilter.Downloaded)) {
		whereClauses.add(
			"s.songId IN (SELECT songId FROM DownloadEntity WHERE status = 'DOWNLOADED')",
		)
	}

	val whereSql = " WHERE " + whereClauses.joinToString(" AND ")

	if (idsOnly) {
		val sql = "SELECT s.songId FROM SongEntity s " +
			"INNER JOIN PlaylistSongCrossRef ps ON s.songId = ps.songId$whereSql"
		return createRoomRawQuery(sql, args)
	}

	var orderBy = when (this) {
		DomainPlaylistSongSort.PlaylistOrder -> "ps.position ASC"
		DomainPlaylistSongSort.RecentlyAdded -> "ps.position DESC"
		DomainPlaylistSongSort.Title -> "LOWER(s.title) ASC"
		DomainPlaylistSongSort.Artist ->
			"LOWER(COALESCE(s.artistName, '')) ASC, LOWER(s.title) ASC"
		DomainPlaylistSongSort.Album ->
			"LOWER(COALESCE(s.albumTitle, '')) ASC, ps.position ASC"
		DomainPlaylistSongSort.Duration -> "s.duration DESC"
	}

	if (reversed && this != DomainPlaylistSongSort.RecentlyAdded) {
		orderBy = orderBy.reverseOrder()
	}

	val sql = "SELECT s.* FROM SongEntity s " +
		"INNER JOIN PlaylistSongCrossRef ps ON s.songId = ps.songId" +
		whereSql +
		" ORDER BY $orderBy"

	return createRoomRawQuery(sql, args)
}
