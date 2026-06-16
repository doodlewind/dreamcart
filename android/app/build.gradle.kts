plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "games.dreamcart"
    compileSdk = 35

    defaultConfig {
        applicationId = "games.dreamcart"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // The bottom-screen UI uses only framework widgets, so no AndroidX UI libs
    // are required — keeping the dependency surface minimal.
    implementation("androidx.core:core-ktx:1.13.1")
}
