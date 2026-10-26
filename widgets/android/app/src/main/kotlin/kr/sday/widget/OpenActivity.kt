package kr.sday.widget

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** 위젯을 누르면 잠깐 거쳐 가는 보이지 않는 화면: 누르는 순간에 S-DAY 앱을 찾아 연다 */
class OpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: Widgets.APP_URL
        runCatching { startActivity(Widgets.appIntent(this, url)) }
            .onFailure { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
        finish()
        overridePendingTransition(0, 0)
    }
}
