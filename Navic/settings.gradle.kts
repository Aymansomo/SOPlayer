/*
 * Navic, a Subsonic music streaming app for Android
 * Copyright (c) 2026 paige
 * SPDX-License-Identifier: GPL-3.0-only
 */

@file:Suppress("UnstableApiUsage")

import androidx.media3.buildlogic.includeMedia3

val localProps = file("local.properties")
val media3LocalProps = file("vendor/androidx-media/local.properties")
if (localProps.exists()) {
	if (!media3LocalProps.exists() || media3LocalProps.readText() != localProps.readText()) {
		localProps.copyTo(media3LocalProps, overwrite = true)
	}
}

rootProject.name = "Navic"
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

pluginManagement {
	includeBuild("vendor/androidx-media/build-logic-settings")
	repositories {
		google {
			mavenContent {
				includeGroupAndSubgroups("androidx")
				includeGroupAndSubgroups("com.android")
				includeGroupAndSubgroups("com.google")
			}
		}
		mavenCentral()
		gradlePluginPortal()
	}
}

plugins {
	id("gradlebuild.media3-settings-logic")
}

dependencyResolutionManagement {
	repositories {
		google {
			mavenContent {
				includeGroupAndSubgroups("androidx")
				includeGroupAndSubgroups("com.android")
				includeGroupAndSubgroups("com.google")
			}
		}
		maven {
			name = "Central Portal Snapshots"
			url = uri("https://central.sonatype.com/repository/maven-snapshots/")
			content {
				includeGroupAndSubgroups("dev.zt64.subsonic")
			}
		}
		maven {
			name = "Jitpack"
			url = uri("https://jitpack.io")
			content {
				includeGroupAndSubgroups("com.github.Nightdavisao")
			}
		}
		mavenCentral()
	}
}

include(":app")
includeMedia3(file("vendor/androidx-media"))
includeBuild("vendor/subsonic-kotlin")
