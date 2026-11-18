package com.ayman.myapps

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import androidx.core.graphics.drawable.toBitmap
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/** One APK kept in the store. */
data class StoredApp(
    val packageName: String,
    val label: String,
    val versionName: String,
    val versionCode: Long,
    val apk: File,
    val icon: File?,
) {
    val size: Long get() = apk.length()
}

/**
 * The phone-side library: APKs live in `files/apks`, icons are cached as PNGs
 * in `files/icons`, and everything else (name, version, package) is read from
 * the APK itself, so nothing can drift out of sync.
 */
class AppStore(private val context: Context) {
    private val pm = context.packageManager
    val apksDir = File(context.filesDir, "apks").apply { mkdirs() }
    private val iconDir = File(context.filesDir, "icons").apply { mkdirs() }

    fun list(): List<StoredApp> = apksDir.listFiles().orEmpty()
        .filter { it.isFile && it.name.endsWith(".apk", ignoreCase = true) }
        .mapNotNull { read(it) }
        .sortedWith(compareBy({ it.label.lowercase(Locale.ROOT) }, { -it.versionCode }))

    fun read(file: File): StoredApp? {
        val archive = pm.getPackageArchiveInfo(file.absolutePath, 0) ?: return null
        val info = archive.applicationInfo ?: return null
        info.sourceDir = file.absolutePath
        info.publicSourceDir = file.absolutePath
        val label = runCatching { pm.getApplicationLabel(info).toString() }.getOrDefault(archive.packageName)
        val code = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        val icon = runCatching { info.loadIcon(pm) }.getOrNull()
        return StoredApp(
            packageName = archive.packageName,
            label = label,
            versionName = archive.versionName ?: "",
            versionCode = code,
            apk = file,
            icon = iconFor(archive.packageName, code, icon),
        )
    }

    private fun iconFor(pkg: String, code: Long, drawable: Drawable?): File? {
        val target = File(iconDir, "$pkg-$code.png")
        if (target.exists()) return target
        val bitmap: Bitmap = runCatching { drawable?.toBitmap(96, 96) }.getOrNull() ?: return null
        return runCatching {
            target.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
            target
        }.getOrNull()
    }

    /** Copy an APK the user picked from storage into the store. */
    fun import(uri: Uri): Result<StoredApp> = runCatching {
        val temp = File.createTempFile("import", ".apk", context.cacheDir)
        try {
            context.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input) { "Cannot read the selected file" }
                temp.outputStream().use { input.copyTo(it) }
            }
            adopt(temp)
        } finally {
            temp.delete()
        }
    }

    /** Download an APK from a link (for example a GitHub release). */
    fun importFromUrl(rawUrl: String, onProgress: (Long, Long) -> Unit = { _, _ -> }): Result<StoredApp> = runCatching {
        val url = URL(rawUrl.trim())
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "MyApps/1.0")
        }
        val temp = File.createTempFile("download", ".apk", context.cacheDir)
        try {
            if (conn.responseCode !in 200..299) error("Server answered ${conn.responseCode}")
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                temp.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var copied = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        out.write(buffer, 0, read)
                        copied += read
                        onProgress(copied, total)
                    }
                }
            }
            adopt(temp)
        } finally {
            conn.disconnect()
            temp.delete()
        }
    }

    private fun adopt(temp: File): StoredApp {
        val app = read(temp) ?: error("That file is not a valid APK")
        val target = File(apksDir, "${app.packageName}-${app.versionCode}.apk")
        if (target.exists()) target.delete()
        if (!temp.renameTo(target)) {
            temp.copyTo(target, overwrite = true)
        }
        return read(target) ?: error("Could not store the APK")
    }

    fun delete(app: StoredApp) {
        runCatching { app.apk.delete() }
        app.icon?.delete()
    }

    /** Installed version code of a package, or null if it isn't installed. */
    fun installedVersion(pkg: String): Long? = runCatching {
        val info = pm.getPackageInfo(pkg, 0)
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }.getOrNull()

    fun openIntent(pkg: String): Intent? = pm.getLaunchIntentForPackage(pkg)

    fun installIntent(app: StoredApp): Intent {
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.files",
            app.apk,
        )
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
