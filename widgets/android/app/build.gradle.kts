plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "kr.sday.widget"
    compileSdk = 34

    defaultConfig {
        applicationId = "kr.sday.widget"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("VERSION_CODE") ?: "0")
    }

    // 서명: CI가 넣어 주는 키(SIGN_*)가 있으면 그걸로, 없으면 디버그 키
    signingConfigs {
        create("release") {
            val store = System.getenv("SIGN_STORE_FILE")
            if (store != null) {
                storeFile = file(store)
                storePassword = System.getenv("SIGN_STORE_PASSWORD")
                keyAlias = System.getenv("SIGN_KEY_ALIAS")
                keyPassword = System.getenv("SIGN_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("SIGN_STORE_FILE") != null) signingConfigs.getByName("release")
                            else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // 위젯 앱 안에서 S-DAY를 앱처럼(주소창 없이 전체 화면) 여는 TWA
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
