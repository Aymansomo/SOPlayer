'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Keep the test isolated from the real Riff data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-online-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const config = require('../src/server/mobile/config');
const library = require('../src/server/mobile/library');
const online = require('../src/server/mobile/online');

function candidate(remoteId, title, artist, extra) {
  return Object.assign({
    remoteId,
    url: `https://example.test/${remoteId}`,
    title,
    artist,
    duration: 200,
    thumbnail: `https://example.test/${remoteId}.jpg`,
  }, extra || {});
}

test('provider ids are stable and distinct from local song ids', () => {
  assert.strictEqual(online.songIdFor('youtube', 'abc'), online.songIdFor('youtube', 'abc'));
  assert.notStrictEqual(online.songIdFor('youtube', 'abc'), online.songIdFor('soundcloud', 'abc'));
  // Albums are identified by artist + album name, so two artists never merge.
  assert.notStrictEqual(
    online.albumIdForTrack({ artist: 'A', album: 'X' }),
    online.albumIdForTrack({ artist: 'B', album: 'X' })
  );
  assert.notStrictEqual(
    online.albumIdForTrack({ artist: 'A', album: 'X' }),
    online.albumIdForTrack({ artist: 'A', album: 'Y' })
  );
  assert.strictEqual(
    online.albumIdForTrack({ artist: 'A', album: 'X' }),
    online.albumIdForTrack({ artist: 'A', album: 'X', title: 'anything' })
  );
});

test('titles are split into artist and title', () => {
  assert.deepStrictEqual(
    online.splitTitleArtist('Daft Punk - One More Time'),
    { artist: 'Daft Punk', title: 'One More Time' }
  );
  assert.deepStrictEqual(
    online.splitTitleArtist('Daft Punk – Around the World (Official Video)'),
    { artist: 'Daft Punk', title: 'Around the World (Official Video)' }
  );
  assert.deepStrictEqual(online.splitTitleArtist('NoDashHere'), { artist: '', title: 'NoDashHere' });
});

test('yt-dlp entries map to candidates for both providers', () => {
  const youtube = online.candidateFromEntry('youtube', {
    id: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
    uploader: 'Rick Astley',
    duration: 213,
    thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg' }],
  });
  assert.strictEqual(youtube.remoteId, 'dQw4w9WgXcQ');
  assert.strictEqual(youtube.artist, 'Rick Astley');
  assert.strictEqual(youtube.title, 'Never Gonna Give You Up');
  // Flat playlist entries only carry the small preview; the mobile server asks
  // for the full-size artwork instead, like the desktop app does.
  assert.strictEqual(youtube.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
  assert.strictEqual(youtube.duration, 213);
  assert.strictEqual(youtube.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const topic = online.candidateFromEntry('youtube', {
    id: 'topic123',
    title: 'Song Name',
    uploader: 'Some Band - Topic',
  });
  assert.strictEqual(topic.artist, 'Some Band');

  const soundcloud = online.candidateFromEntry('soundcloud', {
    id: '123456789',
    title: 'Lofi Mix',
    uploader: 'chillhop',
    duration: 3600,
    webpage_url: 'https://soundcloud.com/chillhop/lofi-mix',
  });
  assert.strictEqual(soundcloud.remoteId, '123456789');
  assert.strictEqual(soundcloud.artist, 'chillhop');
  assert.strictEqual(soundcloud.title, 'Lofi Mix');
  assert.strictEqual(soundcloud.url, 'https://soundcloud.com/chillhop/lofi-mix');

  assert.strictEqual(online.candidateFromEntry('youtube', null), null);
  assert.strictEqual(online.candidateFromEntry('youtube', { title: 'no id' }), null);
});

test('upload noise is stripped and channels do not shadow real artists', () => {
  assert.strictEqual(online.cleanTrackTitle('Let It Happen (Official Video)'), 'Let It Happen');
  assert.strictEqual(online.cleanTrackTitle('Song [Lyrics] (HD)'), 'Song');

  // Channel name as artist: "Tame Impala" uploads "Tame Impala - Let It Happen".
  assert.deepStrictEqual(
    online.parseSmartArtistAndTitle('Tame Impala - Let It Happen (Official Audio)', 'Tame Impala'),
    { artist: 'Tame Impala', title: 'Let It Happen' }
  );

  // Generic channel: the artist lives in the title only.
  assert.deepStrictEqual(
    online.parseSmartArtistAndTitle('Daft Punk - One More Time', 'Various Artists'),
    { artist: 'Daft Punk', title: 'One More Time' }
  );

  // No separator: keep the channel as artist, the title as is.
  assert.deepStrictEqual(
    online.parseSmartArtistAndTitle('Let It Happen (Official Video)', 'Tame Impala'),
    { artist: 'Tame Impala', title: 'Let It Happen' }
  );
});

test('youtube music search gives released tracks, not video uploads', () => {
  const json = {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [{
                  musicShelfRenderer: {
                    contents: [
                      {
                        musicResponsiveListItemRenderer: {
                          flexColumns: [
                            { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Let It Happen' }] } } },
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: {
                                  runs: [
                                    { text: 'Tame Impala' },
                                    { text: ' • ' },
                                    { text: 'Currents' },
                                    { text: ' • ' },
                                    { text: '3:47' },
                                  ],
                                },
                              },
                            },
                          ],
                          playlistItemData: { videoId: 'pFptVrq7NBM' },
                          thumbnail: {
                            musicThumbnailRenderer: {
                              thumbnail: {
                                thumbnails: [{ url: 'https://lh3.googleusercontent.com/abc=w60-h60-l90-rj' }],
                              },
                            },
                          },
                        },
                      },
                      {
                        // Intros and interludes are not songs.
                        musicResponsiveListItemRenderer: {
                          flexColumns: [
                            { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Intro' }] } } },
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: { runs: [{ text: 'Tame Impala' }, { text: ' • ' }, { text: '0:14' }] },
                              },
                            },
                          ],
                          playlistItemData: { videoId: 'short123456' },
                        },
                      },
                    ],
                  },
                }],
              },
            },
          },
        }],
      },
    },
  };

  const songs = online.parseYtmSongs(json);
  assert.strictEqual(songs.length, 1);
  assert.strictEqual(songs[0].title, 'Let It Happen');
  assert.strictEqual(songs[0].artist, 'Tame Impala');
  assert.strictEqual(songs[0].album, 'Currents');
  assert.strictEqual(songs[0].duration, 227);
  assert.strictEqual(songs[0].thumbnail, 'https://lh3.googleusercontent.com/abc=w544-h544');

  // Broken or empty payloads must not throw; the yt-dlp fallback takes over.
  assert.deepStrictEqual(online.parseYtmSongs(null), []);
  assert.deepStrictEqual(online.parseYtmSongs({}), []);
});

test('search results become a browsable online collection', () => {
  const added = online.addCandidates('youtube', [
    candidate('yt-1', 'One More Time', 'Daft Punk', { album: 'Discovery' }),
    candidate('yt-2', 'Around the World', 'Daft Punk', { album: 'Discovery' }),
  ]);
  assert.strictEqual(added.length, 2);

  // Searching the same songs again must not duplicate them.
  online.addCandidates('youtube', [candidate('yt-1', 'One More Time', 'Daft Punk', { album: 'Discovery' })]);
  online.addCandidates('soundcloud', [candidate('sc-1', 'Lofi Mix', 'chillhop')]);
  assert.strictEqual(online.status().tracks, 3);

  // Real albums: two songs of one album form a single album by its artist.
  const albums = online.albums();
  assert.deepStrictEqual(albums.map((album) => album.name).sort(), ['Discovery', 'SoundCloud']);
  const discovery = albums.find((album) => album.name === 'Discovery');
  assert.strictEqual(discovery.artist, 'Daft Punk');
  assert.strictEqual(discovery.songCount, 2);

  const songsInAlbum = online.albumSongs(discovery.id);
  assert.strictEqual(songsInAlbum.length, 2);
  assert.strictEqual(songsInAlbum[0].albumArtist, 'Daft Punk');
  assert.strictEqual(songsInAlbum[0].album, 'Discovery');
  // Songs share the album's artwork, so lists and the album page agree.
  assert.strictEqual(songsInAlbum[0].coverArt, discovery.id);
  assert.strictEqual(songsInAlbum[0].online, true);

  // A track with no album metadata falls back to "Singles", not "YouTube".
  const singles = albums.find((album) => album.name === 'SoundCloud');
  assert.strictEqual(singles.artist, 'chillhop');

  // Real artists, one page each, with their albums.
  const daft = online.artists().find((artist) => artist.name === 'Daft Punk');
  assert.ok(daft);
  assert.strictEqual(daft.albumCount, 1);
  assert.deepStrictEqual(online.artistAlbums(daft.id).map((album) => album.name), ['Discovery']);
  assert.strictEqual(online.getArtist(daft.id).name, 'Daft Punk');

  const songId = online.songIdFor('youtube', 'yt-1');
  const song = online.getSong(songId);
  assert.strictEqual(song.title, 'One More Time');
  assert.strictEqual(song.artist, 'Daft Punk');
  assert.strictEqual(song.artistId, daft.id);
  assert.strictEqual(song.album, 'Discovery');

  // The local library transparently exposes the online entries.
  assert.strictEqual(library.getSong(songId).title, 'One More Time');
  assert.strictEqual(library.getAlbum(discovery.id).songCount, 2);
  assert.strictEqual(library.albumSongs(discovery.id).length, 2);
  assert.ok(library.allAlbums().some((album) => album.id === discovery.id));
  assert.ok(library.allArtists().some((entry) => entry.name === 'Daft Punk'));
  assert.ok(online.searchAlbums('discovery').length >= 1);
  assert.ok(online.searchArtists('daft').length >= 1);
});

test('unknown ids are ignored', async () => {
  assert.strictEqual(online.getSong('does-not-exist'), null);
  assert.strictEqual(online.getAlbum('does-not-exist'), null);
  assert.strictEqual(online.getArtist('does-not-exist'), null);
  assert.strictEqual(await online.ensureCoverArt('does-not-exist'), null);
  assert.strictEqual(await online.streamTrack('does-not-exist', { headers: {} }, {}), false);
});

test('disabling online songs hides and stops resolving them', async () => {
  config.update({ onlineEnabled: false });

  assert.strictEqual(online.getSong(online.songIdFor('youtube', 'yt-1')), null);
  assert.deepStrictEqual(online.albums(), []);
  assert.deepStrictEqual(online.artists(), []);
  assert.strictEqual(library.getSong(online.songIdFor('youtube', 'yt-1')), null);
  assert.ok(!library.allAlbums().some((album) => album.name === 'Discovery'));

  // No yt-dlp spawn is attempted while the feature is off.
  assert.deepStrictEqual(await online.searchSongs('daft punk'), []);
  assert.strictEqual(online.status().enabled, false);

  config.update({ onlineEnabled: true });
  assert.ok(online.getSong(online.songIdFor('youtube', 'yt-1')));
});

test('tracks without a watch URL borrow the video id or a search hit', () => {
  assert.strictEqual(
    online.youtubeWatchUrl({ remoteId: 'NMRhx71bGo4', url: '' }),
    'https://www.youtube.com/watch?v=NMRhx71bGo4'
  );
  // Imported Spotify ids are not video ids, so only a search can find them.
  assert.strictEqual(online.youtubeWatchUrl({ remoteId: 'sp_hwfprme7', url: '' }), '');
  assert.strictEqual(
    online.youtubeWatchUrl({ remoteId: 'sp_hwfprme7', url: 'https://www.youtube.com/watch?v=abcdefghijk' }),
    'https://www.youtube.com/watch?v=abcdefghijk'
  );
});

test('the saved collection is capped, but playlist tracks are pinned', () => {
  online.addCandidates('youtube', [candidate('pin-1', 'Pinned', 'Playlist Artist')], { pinned: true });

  const bulk = [];
  for (let i = 0; i < online.MAX_TRACKS + 20; i++) {
    bulk.push(candidate(`bulk-${i}`, `Song ${i}`, 'Bulk Artist'));
  }
  online.addCandidates('youtube', bulk);
  assert.strictEqual(online.status().tracks, online.MAX_TRACKS);
  assert.ok(
    online.getSong(online.songIdFor('youtube', 'pin-1')),
    'a playlist entry must survive pruning'
  );

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
