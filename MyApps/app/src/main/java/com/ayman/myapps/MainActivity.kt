package com.ayman.myapps

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.graphics.BitmapFactory
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                StoreScreen()
            }
        }
    }
}

private fun formatSize(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024))
    bytes >= 1024 -> String.format("%.0f KB", bytes / 1024.0)
    else -> "$bytes B"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StoreScreen() {
    val context = LocalContext.current
    val store = remember { AppStore(context) }
    val scope = rememberCoroutineScope()

    var apps by remember { mutableStateOf<List<StoredApp>>(emptyList()) }
    val installed = remember { mutableStateMapOf<String, Long>() }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var showUrlDialog by remember { mutableStateOf(false) }
    var urlText by remember { mutableStateOf("") }

    fun refresh() {
        scope.launch {
            val list = withContext(Dispatchers.IO) { store.list() }
            apps = list
            installed.keys.toList().forEach { installed.remove(it) }
            withContext(Dispatchers.IO) {
                list.map { it.packageName }.distinct().forEach { pkg ->
                    store.installedVersion(pkg)?.let { installed[pkg] = it }
                }
            }
            loading = false
        }
    }

    fun install(app: StoredApp) {
        val needsPermission = Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()
        if (needsPermission) {
            message = "Allow \"install unknown apps\" for MyApps, then tap Install again."
            runCatching {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                )
            }
            return
        }
        runCatching { context.startActivity(store.installIntent(app)) }
            .onFailure { message = "Could not open the installer: ${it.message}" }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            loading = true
            var added = 0
            for (uri in uris) {
                val result = withContext(Dispatchers.IO) { store.import(uri) }
                if (result.isSuccess) added++ else message = result.exceptionOrNull()?.message ?: "Import failed"
            }
            loading = false
            message = "Added $added app${if (added == 1) "" else "s"}"
            refresh()
        }
    }

    LifecycleResumeEffect(Unit) {
        refresh()
        onPauseOrDispose { }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("My apps") }) },
        floatingActionButton = {
            FloatingActionButton(onClick = { picker.launch(arrayOf("*/*")) }) {
                Text("+", style = MaterialTheme.typography.headlineMedium)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (busy.isNotEmpty()) {
                Text(busy, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall)
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (message.isNotEmpty()) {
                Text(
                    message,
                    Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { showUrlDialog = true }, modifier = Modifier.weight(1f)) { Text("Add from link") }
                Button(onClick = { picker.launch(arrayOf("*/*")) }, modifier = Modifier.weight(1f)) { Text("Add APK") }
            }
            if (loading && apps.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Loading…") }
            } else if (apps.isEmpty()) {
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(
                        "No apps yet.\nTap + and pick an APK you built (Navic, this store, anything). " +
                            "It stays on the phone and can be installed or updated from here.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(apps, key = { it.packageName + it.versionCode }) { app ->
                        AppCard(
                            app = app,
                            installedCode = installed[app.packageName],
                            onInstall = { install(app) },
                            onOpen = {
                                store.openIntent(app.packageName)?.let { intent ->
                                    runCatching { context.startActivity(intent) }
                                }
                            },
                            onDelete = {
                                store.delete(app)
                                message = "${app.label} removed"
                                refresh()
                            },
                        )
                    }
                }
            }
        }
    }

    if (showUrlDialog) {
        AlertDialog(
            onDismissRequest = { showUrlDialog = false },
            title = { Text("Add from link") },
            text = {
                Column {
                    Text("Paste a direct .apk link (GitHub release asset, your LAN store…).", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        value = urlText,
                        onValueChange = { urlText = it },
                        singleLine = true,
                        label = { Text("https://…/app.apk") },
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = urlText.trim()
                    if (target.isEmpty()) return@TextButton
                    showUrlDialog = false
                    urlText = ""
                    scope.launch {
                        busy = "Downloading…"
                        val result = withContext(Dispatchers.IO) {
                            store.importFromUrl(target) { copied, total ->
                                if (total > 0) busy = "Downloading… ${(copied * 100 / total)}%"
                            }
                        }
                        busy = ""
                        message = result.fold(
                            onSuccess = { "Added ${it.label} ${it.versionName}" },
                            onFailure = { "Download failed: ${it.message}" },
                        )
                        refresh()
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { showUrlDialog = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun AppCard(
    app: StoredApp,
    installedCode: Long?,
    onInstall: () -> Unit,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    val state = when {
        installedCode == null -> "Not installed"
        installedCode < app.versionCode -> "Update available"
        else -> "Installed"
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val bitmap = remember(app.icon?.absolutePath) {
                    app.icon?.let { BitmapFactory.decodeFile(it.absolutePath) }
                }
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)),
                        contentScale = ContentScale.Fit,
                    )
                } else {
                    Box(
                        Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Text(app.label.take(1)) }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(app.label, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${app.packageName} · ${app.versionName.ifEmpty { "v${app.versionCode}" }} · ${formatSize(app.size)}",
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(state, style = MaterialTheme.typography.labelMedium)
            }
            Spacer(Modifier.width(8.dp))
            Row(
                Modifier.fillMaxWidth().padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(onClick = onInstall, modifier = Modifier.weight(1f)) {
                    Text(if (installedCode != null && installedCode < app.versionCode) "Update" else "Install")
                }
                if (installedCode != null) {
                    TextButton(onClick = onOpen) { Text("Open") }
                }
                TextButton(onClick = onDelete) { Text("Remove") }
            }
        }
    }
}
