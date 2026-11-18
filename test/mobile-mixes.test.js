'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Keep the test isolated from the real Riff data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mixes-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const online = require('../src/server/mobile/online');
const collection = require('../src/server/mobile/collection');
const mixes = require('../src/server/mobile/mixes');

const TASTE_ROWS = [
  { song: { id: 's1', title: 'Let It Happen', artist: 'Tame Impala', duration: 468, thumbnail: 'https://example.test/1.jpg' }, weight: 20 },
  { song: { id: 's2', title: 'One More Time', artist: 'Daft Punk', duration: 320, thumbnail: 'https://example.test/2.jpg' }, weight: 12 },
  { song: { id: 's3', title: 'Nightcall', artist: 'Kavinsky', duration: 260, thumbnail: 'https://example.test/3.jpg' }, weight: 8 },
  { song: { id: 's4', title: 'Instant Crush', artist: 'Daft Punk', duration: 337, thumbnail: 'https://example.test/4.jpg' }, weight: 6 },
];

function rows() {
  return TASTE_ROWS.map((row) => ({ song: Object.assign({}, row.song), weight: row.weight }));
}

const requests = [];
let onlineCall = null;

function stubDesktop() {
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body, headers: options.headers });
    if (!onlineCall) return { ok: false, json: async () => ({}) };
    const tag = String(requests.length).padStart(2, '0');
    const seedArtist = (body.seeds[0] && body.seeds[0].artist) || 'Someone';
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      id: `r${tag}s${String(index).padStart(7, '0')}`,
      title: `Pick ${requests.length}-${index + 1}`,
      artist: seedArtist,
      duration: 200,
      thumbnail: '',
      platform: 'youtube',
    }));
    return { ok: true, json: async () => ({ success: true, tracks }) };
  };
}

test('the taste profile becomes a For you list and daily mixes', () => {
  const planned = mixes.planBuckets(rows());
  assert.ok(planned.forYou);
  assert.strictEqual(planned.forYou.id, 'smart_for_you');
  assert.ok(planned.forYou.artists.includes('Tame Impala'));
  assert.strictEqual(planned.mixes.length, 3); // one per artist
  assert.deepStrictEqual(planned.mixes.map((mix) => mix.id), ['smart_daily_1', 'smart_daily_2', 'smart_daily_3']);
  // Seeds carry what the desktop needs and never a local song id.
  for (const seed of planned.forYou.seeds) {
    assert.strictEqual(seed.id, '');
    assert.ok(seed.artist && seed.title);
  }
  assert.deepStrictEqual(mixes.planBuckets([]), { forYou: null, mixes: [] });
});

test('the mixes are new online songs from the desktop, not library tracks', async () => {
  stubDesktop();
  onlineCall = true;
  mixes.reset();
  mixes.setDesktopPort(40000 + Math.floor(Math.random() * 1000));
  mixes.setDesktopToken('test-token');

  const plan = await mixes.refresh(rows());

  // One request for "For you" plus one per Daily Mix, all seeded by taste.
  assert.strictEqual(requests.length, 4);
  // The desktop only accepts its own token on /api/vibe.
  assert.strictEqual(requests[0].headers['x-riff-token'], 'test-token');
  assert.ok(requests[0].body.seeds.length > 0);
  assert.ok(requests[0].body.avoid.keys.includes('tame impala let it happen'));

  assert.strictEqual(plan.day, mixes.dayKey());
  assert.ok(plan.forYou);
  assert.strictEqual(plan.mixes.length, 3);

  const playlists = mixes.currentPlaylists();
  assert.deepStrictEqual(playlists.map((entry) => entry.name), ['For you', 'Daily Mix 1', 'Daily Mix 2', 'Daily Mix 3']);

  const songs = playlists[0].songs;
  assert.strictEqual(songs.length, 5);
  assert.strictEqual(songs[0].online, true);
  // The recommendations were added to the online collection so they stream.
  assert.ok(online.getSong(songs[0].id));
  // None of them is a song from the listening history.
  const seedTitles = new Set(TASTE_ROWS.map((row) => row.song.title));
  for (const song of songs) assert.ok(!seedTitles.has(song.title));

  // The plan is remembered for the rest of the day.
  assert.ok(fs.existsSync(mixes.MIXES_PATH));
  assert.strictEqual(mixes.isStale(), false);
});

test('recommendation tracks survive collection pruning until their day ends', async () => {
  const first = mixes.currentPlaylists()[0].songs[0];
  assert.ok(online.getSong(first.id));

  // Overflow the online collection; mix tracks are only temporarily pinned,
  // so they must still be there afterwards.
  const filler = Array.from({ length: online.MAX_TRACKS + 50 }, (_, index) => ({
    remoteId: `fill${String(index).padStart(7, '0')}`,
    title: `Filler ${index}`,
    artist: 'Filler Artist',
    duration: 180,
  }));
  online.addCandidates('youtube', filler);

  assert.ok(online.getSong(first.id), 'mix track survived pruning');
});

test('the phone home rows show the recommended mixes', async () => {
  const smart = collection.playlists().filter((playlist) => playlist.id.startsWith('smart_'));
  const forYou = smart.find((playlist) => playlist.id === 'smart_for_you');
  assert.ok(forYou);
  assert.strictEqual(forYou.songs.length, 5);
  assert.strictEqual(forYou.artist, undefined);
  assert.ok(smart.some((playlist) => playlist.id === 'smart_daily_1' && playlist.songs.length === 5));
});

test("the PC's own Daily Mixes are shown on the phone", () => {
  mixes.reset();
  const payload = {
    day: mixes.dayKey(),
    mixes: [
      {
        name: 'Daily Mix 1',
        artists: ['Tame Impala'],
        tracks: [
          { id: 'pcMix000001', title: 'Borderline', artist: 'Tame Impala', duration: 238, platform: 'ytmusic' },
          { id: 'pcMix000002', title: 'The Less I Know the Better', artist: 'Tame Impala', duration: 216, platform: 'ytmusic' },
        ],
      },
      {
        name: 'Daily Mix 2',
        artists: ['Daft Punk'],
        tracks: [
          { id: 'pcMix000003', title: 'Veridis Quo', artist: 'Daft Punk', duration: 346, platform: 'ytmusic' },
          { id: 'pcMix000004', title: 'Something About Us', artist: 'Daft Punk', duration: 232, platform: 'ytmusic' },
        ],
      },
    ],
  };

  assert.strictEqual(mixes.setDesktopMixes(payload), true);
  const playlists = mixes.currentPlaylists();
  assert.deepStrictEqual(playlists.map((entry) => entry.name), ['Daily Mix 1', 'Daily Mix 2']);
  assert.deepStrictEqual(playlists[0].songs.map((song) => song.title), ['Borderline', 'The Less I Know the Better']);
  assert.ok(online.getSong(playlists[0].songs[0].id));

  // The renderer pushes this every 15s; an unchanged push is a no-op.
  assert.strictEqual(mixes.setDesktopMixes(payload), false);

  // A mix set cached from yesterday is not what the PC shows today.
  assert.strictEqual(mixes.setDesktopMixes(Object.assign({}, payload, { day: '2000-01-01' })), false);
});

test('PC favourites and play history reach the phone', () => {
  const track = {
    id: 'favSong0001',
    title: 'Dark Red',
    artist: 'Steve Lacy',
    platform: 'ytmusic',
    duration: 200,
    playedAt: 2000,
  };

  collection.syncFromRenderer({ favorites: [track], history: [track], playlists: [] });

  const starred = collection.starredSongs();
  const song = starred.find((entry) => entry.title === 'Dark Red');
  assert.ok(song, 'the starred online song is servable on the phone');
  assert.strictEqual(collection.playCount(song), 1, 'the PC play became a play count');

  // The same history pushed again must not count the same play twice.
  collection.syncFromRenderer({ favorites: [track], history: [track], playlists: [] });
  assert.strictEqual(collection.playCount(song), 1);

  // Subsonic clients parse `starred` as a date; a boolean broke Navic's
  // starred response and left its Starred screen empty.
  const starredAt = collection.starredAt(song);
  assert.ok(starredAt);
  assert.ok(!Number.isNaN(Date.parse(starredAt)));

  const { routes, okResponse } = require('../src/server/mobile/subsonic');
  const payload = okResponse(routes.getstarred2(new URLSearchParams()));
  const served = payload.starred2.song.find((entry) => entry.title === 'Dark Red');
  assert.ok(served);
  assert.strictEqual(typeof served.starred, 'string');
  assert.ok(!Number.isNaN(Date.parse(served.starred)));
});

test('an unreachable desktop keeps the mixes instead of wiping them', async () => {
  onlineCall = false;
  const before = mixes.currentPlaylists().length;
  assert.ok(before > 0);
  const plan = await mixes.refresh(rows());
  assert.strictEqual(plan.forYou !== null || plan.mixes.length > 0, true);
  assert.strictEqual(mixes.currentPlaylists().length, before);
});
