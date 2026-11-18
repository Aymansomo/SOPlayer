/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.screen.collection.viewmodel

import androidx.compose.foundation.lazy.LazyListState
import androidx.lifecycle.viewModelScope
import androidx.paging.PagingData
import androidx.paging.cachedIn
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import paige.navic.R
import paige.navic.database.mapper.toDomainModel
import paige.navic.domain.manager.session.connectivity.ReachabilityFlow
import paige.navic.domain.manager.session.SessionManager
import paige.navic.domain.manager.session.DownloadManager
import paige.navic.domain.manager.session.SessionState
import paige.navic.domain.manager.ui.SnackBarManager
import paige.navic.domain.model.DomainAlbum
import paige.navic.domain.model.DomainAlbumInfo
import paige.navic.domain.model.DomainFilter
import paige.navic.domain.model.DomainPlaylist
import paige.navic.domain.model.DomainPlaylistSongSort
import paige.navic.domain.model.DomainSong
import paige.navic.domain.model.DomainSongCollection
import paige.navic.domain.repository.AlbumRepository
import paige.navic.domain.repository.CollectionRepository
import paige.navic.domain.repository.SongRepository
import paige.navic.playback.MediaPlayer
import paige.navic.ui.viewmodel.AsyncViewModel

data class CollectionViewState(
	val collection: DomainSongCollection? = null,
	val starred: Boolean = false,
	val rating: Int = 0,
	val albumInfo: DomainAlbumInfo? = null,
	val selectedSong: DomainSong? = null,
	val selectedIndex: Int? = null,
	val selectedAlbum: DomainAlbum? = null
)

@OptIn(ExperimentalCoroutinesApi::class)
class CollectionDetailViewModel(
	private val collectionId: String,
	private val repository: CollectionRepository,
	private val songRepository: SongRepository,
	private val albumRepository: AlbumRepository,
	private val sessionManager: SessionManager,
	private val snackBarManager: SnackBarManager,
	private val downloadManager: DownloadManager,
	reachability: ReachabilityFlow
) : AsyncViewModel<CollectionViewState>() {

	init {
		execute {
			CollectionViewState(
				collection = repository.getLocalData(collectionId)
			)
		}
	}

	val listState = LazyListState()

	val isReachable = reachability.isReachable

	val sort = MutableStateFlow(DomainPlaylistSongSort.PlaylistOrder)
	val reversed = MutableStateFlow(false)
	val filters = MutableStateFlow<Set<DomainFilter>>(emptySet())

	val pagedSongs: Flow<PagingData<DomainSong>> = combine(sort, reversed, filters) {
		sorting, isReversed, activeFilters -> Triple(sorting, isReversed, activeFilters)
	}
		.flatMapLatest { (sorting, isReversed, activeFilters) ->
			repository.getPagedPlaylistSongs(collectionId, sorting, isReversed, activeFilters)
		}
		.cachedIn(viewModelScope)

	fun setSorting(sorting: DomainPlaylistSongSort) {
		sort.value = sorting
	}

	/**
	 * Start [startSong] from the list the user is looking at. The queue is loaded
	 * with the same sort and filters the screen uses, otherwise a song pressed
	 * under "newest first" played whatever sat at that index in the server's
	 * original playlist order.
	 */
	fun playFrom(player: MediaPlayer, startSong: DomainSong) = launch {
		val songs = when (val collection = data?.collection) {
			is DomainPlaylist -> repository.getPlaylistSongs(
				playlistId = collection.id,
				sort = sort.value,
				reversed = reversed.value,
				filters = filters.value
			)

			is DomainAlbum -> collection.songs.sortedWith(
				compareBy({ it.discNumber }, { it.trackNumber })
			)

			else -> emptyList()
		}
		if (songs.isEmpty()) {
			player.playNow(startSong)
			return@launch
		}
		player.playNow(
			songs = songs,
			startIndex = songs.indexOfFirst { it.id == startSong.id }.coerceAtLeast(0)
		)
	}

	fun setReversed(value: Boolean) {
		reversed.value = value
	}

	fun toggleFilter(filter: DomainFilter) {
		filters.value = if (filter in filters.value) {
			filters.value - filter
		} else {
			filters.value + filter
		}
	}

	val otherAlbums = uiState
		.map { state -> (state.data?.collection as? DomainAlbum) }
		.flatMapLatest { album ->
			album?.let { repository.getOtherAlbums(it.artistId, it.id) } ?: emptyFlow()
		}
		.stateIn(
			scope = viewModelScope,
			started = SharingStarted.Lazily,
			initialValue = emptyList()
		)

	init {
		launch {
			sessionManager.sessionState.collect { if (it is SessionState.Authenticated) refreshCollection(false) }
		}
	}

	fun refreshCollection(fullRefresh: Boolean) = launch {
		val collection = repository.getCollection(fullRefresh, collectionId)
		val state = if (collection is DomainAlbum) {
			CollectionViewState(
				collection = collection,
				starred = albumRepository.isAlbumStarred(collection.id),
				rating = albumRepository.getAlbumRating(collection.id),
				albumInfo = repository.getAlbumInfo(collectionId).toDomainModel()
			)
		} else {
			CollectionViewState(collection = collection)
		}
		setSuccess(state)
		// A playlist the user downloaded keeps downloading songs that were just
		// added to it, without pressing the download button again.
		if (collection is DomainPlaylist) downloadManager.syncAutoDownload(collectionId)
	}

	fun selectSong(song: DomainSong, index: Int) = updateData {
		it.copy(
			selectedSong = song,
			selectedIndex = index
		)
	}

	fun selectAlbum(album: DomainAlbum) = updateData {
		it.copy(
			selectedAlbum = album
		)
	}

	fun clearSelection() = updateData {
		it.copy(selectedSong = null, selectedAlbum = null)
	}

	fun removeFromPlaylist() {
		val index = uiState.value.data?.selectedIndex ?: return
		launch {
			repository.removeSongFromPlaylist(collectionId, index)
			snackBarManager.notify(R.string.notice_removed_from_playlist)
			refreshCollection(true)
		}
		clearSelection()
	}

	fun starSelectedSong() = launch {
		val selection = uiState.value.data?.selectedSong ?: return@launch
		songRepository.starSong(selection.id)
		refreshCollection(false)
	}

	fun unstarSelectedSong() = launch {
		val selection = uiState.value.data?.selectedSong ?: return@launch
		songRepository.unstarSong(selection.id)
		refreshCollection(false)
	}

	fun rateSelectedSong(rating: Int) = launch {
		val selection = uiState.value.data?.selectedSong ?: return@launch
		songRepository.rateSong(selection.id, rating)
	}

	fun rateAlbum(newRating: Int) = launch {
		(uiState.value.data?.collection as? DomainAlbum)?.let { album ->
			albumRepository.rateAlbum(album.id, newRating)
		}
	}

	fun starAlbum(starred: Boolean) {
		launch {
			val collection = data?.collection
			if (collection !is DomainAlbum) return@launch
			if (starred) {
				albumRepository.starAlbum(collection.id)
			} else {
				albumRepository.unstarAlbum(collection.id)
			}
			refreshCollection(false)
		}
	}

	fun rateSelectedAlbum(rating: Int) {
		launch {
			data?.selectedAlbum?.let { albumRepository.rateAlbum(it.id, rating) }
		}
	}

	fun starSelectedAlbum(starred: Boolean) {
		launch {
			val album = data?.selectedAlbum ?: return@launch
			if (starred) {
				albumRepository.starAlbum(album.id)
			} else {
				albumRepository.unstarAlbum(album.id)
			}
		}
	}

}
