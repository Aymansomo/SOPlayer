/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.domain.repository

import androidx.paging.PagingData
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import paige.navic.database.dao.SongDao
import paige.navic.database.entity.SyncActionType
import paige.navic.database.mapper.toDomainModel
import paige.navic.database.paging.createPagedFlow
import paige.navic.database.query.toSqlQuery
import paige.navic.domain.manager.session.SyncManager
import paige.navic.domain.model.DomainFilter
import paige.navic.domain.model.DomainSong
import paige.navic.domain.model.DomainSongListType
import kotlin.time.Clock

class SongRepository(
	private val songDao: SongDao,
	private val dbRepository: DbRepository,
	private val syncManager: SyncManager
) {
	suspend fun getSongById(id: String) = songDao.getSongById(id)?.toDomainModel()

	/**
	 * Every starred song, for the Starred screen. It used to be paged, which left
	 * the screen showing only the first rows of a horizontally scrolling grid
	 * while the rest of the liked songs sat off-screen.
	 */
	fun getStarredSongs(): Flow<List<DomainSong>> = songDao
		.getStarredSongs()
		.map { songs -> songs.map { it.toDomainModel() } }

	suspend fun getRandomSongsList(count: Int): List<DomainSong> {
		return songDao.getRandomSongsList(count).map { it.toDomainModel() }
	}

	private suspend fun getLocalData(
		listType: DomainSongListType,
		reversed: Boolean = false,
		filters: Set<DomainFilter> = emptySet()
	): Flow<PagingData<DomainSong>> = createPagedFlow(
		isRandom = (listType == DomainSongListType.Random),
		getRandomIds = {
			songDao.getSongIdsByQuery(
				listType.toSqlQuery(
					filters = filters,
					idsOnly = true
				)
			)
		},
		getEntityId = { it.songId },
		fetchByIds = songDao::getSongsByIds,
		getStandardQuery = { songDao.getPagedSongsByQuery(listType.toSqlQuery(reversed, filters)) },
		toDomain = { it.toDomainModel() }
	)

	private suspend fun refreshLocalData(
		listType: DomainSongListType,
		reversed: Boolean = false,
		filters: Set<DomainFilter> = emptySet()
	): Flow<PagingData<DomainSong>> {
		if (filters.contains(DomainFilter.Starred)) {
			// Stars made on the PC/phone, without re-downloading the library.
			dbRepository.syncStarred().getOrThrow()
		} else {
			dbRepository.syncLibrarySongs().getOrThrow()
		}
		return getLocalData(listType, reversed, filters)
	}

	suspend fun getSongs(
		fullRefresh: Boolean,
		listType: DomainSongListType,
		reversed: Boolean,
		filters: Set<DomainFilter>
	): Flow<PagingData<DomainSong>> {
		val localData = getLocalData(listType, reversed, filters)
		// Stars are account state, not library pages: a Starred list opened from
		// anywhere (the Library shortcuts included) must ask the server first,
		// otherwise a star made on the PC only appeared after a full sync.
		return if (fullRefresh || filters.contains(DomainFilter.Starred)) {
			refreshLocalData(listType, reversed, filters)
		} else {
			localData
		}
	}

	suspend fun isSongStarred(songId: String) = songDao.isSongStarred(songId)
	suspend fun getSongRating(songId: String) = songDao.getSongRating(songId) ?: 0
	suspend fun starSong(songId: String) {
		songDao.updateSongStarredAt(songId, Clock.System.now())
		syncManager.enqueueAction(SyncActionType.STAR, songId)
	}

	suspend fun unstarSong(songId: String) {
		songDao.updateSongStarredAt(songId, null)
		syncManager.enqueueAction(SyncActionType.UNSTAR, songId)
	}

	suspend fun rateSong(songId: String, rating: Int) {
		songDao.updateSongRating(songId, rating.takeIf { it > 0 })
		when (rating) {
			0 -> syncManager.enqueueAction(SyncActionType.STAR_0, songId)
			1 -> syncManager.enqueueAction(SyncActionType.STAR_1, songId)
			2 -> syncManager.enqueueAction(SyncActionType.STAR_2, songId)
			3 -> syncManager.enqueueAction(SyncActionType.STAR_3, songId)
			4 -> syncManager.enqueueAction(SyncActionType.STAR_4, songId)
			5 -> syncManager.enqueueAction(SyncActionType.STAR_5, songId)
		}
	}
}
