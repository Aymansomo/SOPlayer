/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

package paige.navic.ui.screen.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import org.koin.compose.koinInject
import org.koin.compose.viewmodel.koinViewModel
import paige.navic.R
import paige.navic.di.LocalBottomBarScrollManager
import paige.navic.di.LocalSizeClass
import paige.navic.domain.manager.runtime.PreferenceManager
import paige.navic.domain.model.settings.BottomBarVisibilityMode
import paige.navic.ui.component.layout.NestedTopBar
import paige.navic.ui.component.layout.RootBottomBar
import paige.navic.ui.icons.Icons
import paige.navic.ui.icons.filled.Headphones
import paige.navic.ui.icons.outlined.PlaylistPlay
import paige.navic.ui.icons.filled.Pause
import paige.navic.ui.icons.filled.Play
import paige.navic.ui.icons.filled.SkipNext
import paige.navic.ui.icons.filled.SkipPrevious
import paige.navic.ui.icons.filled.Star
import paige.navic.ui.screen.remote.viewmodel.RemoteUiState
import paige.navic.ui.screen.remote.viewmodel.RemoteViewModel
import paige.navic.ui.theme.NavicTheme

@Composable
fun RemoteScreen(
	nested: Boolean = false
) {
	val preferenceManager = koinInject<PreferenceManager>()
	val viewModel = koinViewModel<RemoteViewModel>()
	val state by viewModel.state.collectAsStateWithLifecycle()

	NavicTheme {
		Scaffold(
			topBar = {
				NestedTopBar(title = { Text(stringResource(R.string.title_remote)) })
			},
			bottomBar = {
				val sizeClass = LocalSizeClass.current
				val scrollManager = LocalBottomBarScrollManager.current
				val preferVisible =
					preferenceManager.bottomBarVisibilityMode == BottomBarVisibilityMode.AllScreens
				if (!nested
					|| (sizeClass.widthSizeClass < WindowWidthSizeClass.Medium && preferVisible)
				) {
					RootBottomBar(scrolled = scrollManager.isTriggered)
				}
			}
		) { contentPadding ->
			Box(
				modifier = Modifier
					.fillMaxSize()
					.padding(contentPadding),
				contentAlignment = Alignment.Center
			) {
				when {
					state.isConnecting && !state.connected -> {
						CircularProgressIndicator()
					}

					!state.connected -> {
						Column(
							modifier = Modifier
								.fillMaxWidth()
								.padding(horizontal = 32.dp),
							horizontalAlignment = Alignment.CenterHorizontally
						) {
							Text(
								text = stringResource(R.string.remote_unreachable),
								style = MaterialTheme.typography.bodyLarge,
								textAlign = TextAlign.Center
							)
							state.error?.let { message ->
								Spacer(Modifier.height(8.dp))
								Text(
									text = message,
									style = MaterialTheme.typography.bodySmall,
									color = MaterialTheme.colorScheme.onSurfaceVariant,
									textAlign = TextAlign.Center
								)
							}
							Spacer(Modifier.height(16.dp))
							FilledTonalButton(onClick = viewModel::connect) {
								Text(stringResource(R.string.remote_retry))
							}
						}
					}

					else -> {
						RemoteController(state = state, viewModel = viewModel)
					}
				}
			}
		}
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RemoteController(
	state: RemoteUiState,
	viewModel: RemoteViewModel
) {
	val duration = state.duration.toFloat().coerceAtLeast(1f)
	var dragging by remember { mutableStateOf(false) }
	var draggedPosition by remember { mutableStateOf(0f) }
	var showPicker by remember { mutableStateOf(false) }
	val position = if (dragging) draggedPosition else state.position.toFloat().coerceIn(0f, duration)

	Column(
		modifier = Modifier
			.fillMaxWidth()
			.padding(horizontal = 24.dp, vertical = 16.dp),
		horizontalAlignment = Alignment.CenterHorizontally
	) {
		val thumbnail = state.track?.thumbnail
		if (!thumbnail.isNullOrBlank()) {
			AsyncImage(
				model = thumbnail,
				contentDescription = stringResource(R.string.remote_media_art),
				contentScale = ContentScale.Crop,
				modifier = Modifier
					.size(224.dp)
					.clip(RoundedCornerShape(24.dp))
			)
		} else {
			Surface(
				modifier = Modifier.size(224.dp),
				color = MaterialTheme.colorScheme.surfaceContainerHighest,
				shape = RoundedCornerShape(24.dp)
			) {
				Box(contentAlignment = Alignment.Center) {
					Icon(
						imageVector = Icons.Filled.Headphones,
						contentDescription = null,
						modifier = Modifier.size(64.dp)
					)
				}
			}
		}

		Spacer(Modifier.height(20.dp))
		Text(
			text = state.track?.title ?: stringResource(R.string.remote_nothing_playing),
			style = MaterialTheme.typography.headlineSmall,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis
		)
		Text(
			text = state.track?.artist.orEmpty(),
			style = MaterialTheme.typography.bodyMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			maxLines = 1,
			overflow = TextOverflow.Ellipsis
		)

		Spacer(Modifier.height(16.dp))
		Slider(
			value = position,
			onValueChange = {
				dragging = true
				draggedPosition = it
			},
			onValueChangeFinished = {
				dragging = false
				viewModel.command("seek", draggedPosition.toDouble())
			},
			valueRange = 0f..duration,
			enabled = state.canControl,
			modifier = Modifier.fillMaxWidth()
		)
		Row(
			modifier = Modifier.fillMaxWidth(),
			horizontalArrangement = Arrangement.SpaceBetween
		) {
			Text(
				text = formatTime(position),
				style = MaterialTheme.typography.labelMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant
			)
			Text(
				text = formatTime(duration),
				style = MaterialTheme.typography.labelMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant
			)
		}

		Spacer(Modifier.height(8.dp))
		Row(
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(8.dp)
		) {
			IconButton(
				onClick = { viewModel.command("prev") },
				enabled = state.canControl
			) {
				Icon(
					imageVector = Icons.Filled.SkipPrevious,
					contentDescription = stringResource(R.string.remote_previous)
				)
			}
			IconButton(
				onClick = { viewModel.command("playpause") },
				enabled = state.canControl,
				modifier = Modifier.size(72.dp)
			) {
				Icon(
					imageVector = if (state.playing) Icons.Filled.Pause else Icons.Filled.Play,
					contentDescription = stringResource(R.string.remote_play_pause),
					modifier = Modifier.size(48.dp)
				)
			}
			IconButton(
				onClick = { viewModel.command("next") },
				enabled = state.canControl
			) {
				Icon(
					imageVector = Icons.Filled.SkipNext,
					contentDescription = stringResource(R.string.remote_next)
				)
			}
			IconButton(
				onClick = { viewModel.command(if (state.liked) "unlike" else "like") },
				enabled = state.canControl
			) {
				Icon(
					imageVector = Icons.Filled.Star,
					contentDescription = stringResource(R.string.remote_like),
					tint = if (state.liked) MaterialTheme.colorScheme.primary
					else MaterialTheme.colorScheme.onSurfaceVariant
				)
			}
		}

		Spacer(Modifier.height(12.dp))
		// Transport buttons only steer what the PC already has; this is how the
		// phone picks what the PC should play next.
		FilledTonalButton(
			onClick = {
				viewModel.loadPlaylists()
				showPicker = true
			},
			enabled = state.remoteEnabled
		) {
			Icon(
				imageVector = Icons.Outlined.PlaylistPlay,
				contentDescription = null,
				modifier = Modifier.size(18.dp)
			)
			Spacer(Modifier.width(8.dp))
			Text(stringResource(R.string.remote_play_something))
		}
		state.playStatus?.let { status ->
			Spacer(Modifier.height(6.dp))
			Text(
				text = status,
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				textAlign = TextAlign.Center
			)
		}

		Spacer(Modifier.height(8.dp))
		Text(
			text = stringResource(R.string.remote_volume),
			style = MaterialTheme.typography.labelLarge,
			color = MaterialTheme.colorScheme.onSurfaceVariant
		)
		Slider(
			value = state.volume.toFloat().coerceIn(0f, 1f),
			onValueChange = { viewModel.command("volume", it.toDouble()) },
			valueRange = 0f..1f,
			enabled = state.canControl,
			modifier = Modifier.fillMaxWidth()
		)

		if (!state.remoteEnabled) {
			Text(
				text = stringResource(R.string.remote_disabled),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.error,
				textAlign = TextAlign.Center
			)
		} else if (state.stale) {
			Text(
				text = stringResource(R.string.remote_stale),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				textAlign = TextAlign.Center
			)
		}
	}

	if (showPicker) {
		ModalBottomSheet(onDismissRequest = { showPicker = false }) {
			Text(
				text = stringResource(R.string.remote_choose_what_plays),
				style = MaterialTheme.typography.titleMedium,
				modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp)
			)
			if (state.playlists.isEmpty() && state.loadingPlaylists) {
				CircularProgressIndicator(modifier = Modifier.padding(24.dp))
			} else if (state.playlists.isEmpty()) {
				Text(
					text = stringResource(R.string.info_no_playlists),
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.padding(24.dp)
				)
			} else {
				LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
					items(state.playlists, key = { playlist -> playlist.id }) { playlist ->
						ListItem(
							headlineContent = { Text(playlist.name.orEmpty()) },
							supportingContent = {
								Text(
									pluralStringResource(
										R.plurals.count_songs,
										playlist.songCount,
										playlist.songCount
									)
								)
							},
							leadingContent = { Icon(Icons.Outlined.PlaylistPlay, null) },
							modifier = Modifier.clickable {
								showPicker = false
								viewModel.playPlaylistOnPc(playlist)
							}
						)
					}
				}
			}
		}
	}
}

private fun formatTime(seconds: Float): String {
	val total = seconds.toLong().coerceAtLeast(0L)
	val minutes = total / 60
	val remainder = total % 60
	return if (minutes >= 60) {
		"%d:%02d:%02d".format(minutes / 60, minutes % 60, remainder)
	} else {
		"%d:%02d".format(minutes, remainder)
	}
}
