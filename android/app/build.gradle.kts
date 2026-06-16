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

// The top screen reuses the isomorphic web engine; engine.js + the games
// manifest are generated (and gitignored) by android/sync-assets.ts. Wire that
// into the build so a direct `./gradlew` / Android Studio / CI build can never
// ship missing or stale assets (which would render a blank WebView).
val syncDreamcartAssets by tasks.registering {
    description = "Sync DreamCart engine.js + games manifest into app assets."
    val assetsDir = file("src/main/assets")
    val script = rootProject.file("sync-assets.ts")
    doLast {
        try {
            exec {
                workingDir = rootProject.projectDir
                commandLine("bun", script.absolutePath)
            }
        } catch (e: Exception) {
            logger.warn("DreamCart: could not run 'bun ${script.name}' (${e.message}); using existing assets.")
        }
        // Hard guard: the runtime is useless without these two files.
        if (!assetsDir.resolve("engine.js").exists() || !assetsDir.resolve("games.generated.js").exists()) {
            throw GradleException(
                "Missing web assets in $assetsDir.\n" +
                    "Run `bun android/sync-assets.ts` (needs Bun on PATH) before building.",
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(syncDreamcartAssets) }
