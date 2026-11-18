plugins {
	alias(libs.plugins.android.application)
	alias(libs.plugins.compose.compiler)
}

kotlin {
	jvmToolchain(21)
}

android {
	namespace = "com.ayman.myapps"
	compileSdk = 37
	compileSdkMinor = 2

	defaultConfig {
		applicationId = "com.ayman.myapps"
		minSdk = 24
		targetSdk = 37
		versionCode = 1
		versionName = "1.0"
	}

	buildFeatures {
		compose = true
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_21
		targetCompatibility = JavaVersion.VERSION_21
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}
}

dependencies {
	implementation(libs.androidx.activity.compose)
	implementation(libs.androidx.core.ktx)
	implementation(libs.androidx.lifecycle.runtime.compose)
	implementation(libs.compose.foundation)
	implementation(libs.compose.material3)
	implementation(libs.compose.ui)
}
