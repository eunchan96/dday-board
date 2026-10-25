package kr.sday.widget

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.SeekBar
import android.widget.TextView
import kotlin.concurrent.thread

/** 위젯 주소를 넣는 화면 (S-DAY 설정 → 위젯에서 복사한 주소) */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val url = findViewById<EditText>(R.id.url)
        val status = findViewById<TextView>(R.id.status)
        url.setText(Store.url(this))
        if (Store.url(this).isNotBlank()) status.text = "저장된 주소가 있어요. 홈 화면에 S-DAY 위젯을 추가하세요."

        findViewById<Button>(R.id.paste).setOnClickListener {
            val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
            if (text.isNotEmpty()) url.setText(text) else status.text = "복사한 내용이 없어요."
        }

        findViewById<Button>(R.id.save).setOnClickListener {
            val value = url.text.toString().trim()
            if (!Store.looksValid(value)) {
                status.text = "위젯 주소가 아니에요. S-DAY 설정 → 위젯에서 복사한 주소를 넣어 주세요."
                return@setOnClickListener
            }
            Store.setUrl(this, value)
            status.text = "확인하는 중…"
            thread {
                val msg = try {
                    val data = Api.parse(Api.fetch(this))
                    "저장했어요. 다가오는 일정 ${data.upcoming.size}개를 받았어요.\n홈 화면을 길게 눌러 위젯 → S-DAY에서 오늘 공부 · 타이머 · 다가오는 일정 · 캘린더를 골라 추가하세요."
                } catch (e: WidgetError) {
                    e.message ?: "불러오지 못했어요"
                } catch (e: Exception) {
                    "불러오지 못했어요. 인터넷 연결을 확인해 주세요."
                }
                runOnUiThread {
                    status.text = msg
                    Widgets.render(this)
                    RefreshWorker.schedule(this)
                }
            }
        }

        // 배경 진하기: 0~100%를 10단계로
        val opacity = findViewById<SeekBar>(R.id.opacity)
        val opacityLabel = findViewById<TextView>(R.id.opacity_label)
        fun showOpacity(v: Int) { opacityLabel.text = "위젯 배경 진하기 $v%" }
        opacity.progress = Store.opacity(this) / 10
        showOpacity(Store.opacity(this))
        opacity.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {
                if (!fromUser) return
                Store.setOpacity(this@MainActivity, value * 10)
                showOpacity(value * 10)
                Widgets.render(this@MainActivity)
            }
            override fun onStartTrackingTouch(bar: SeekBar) {}
            override fun onStopTrackingTouch(bar: SeekBar) {}
        })

        findViewById<Button>(R.id.open).setOnClickListener {
            startActivity(Widgets.appIntent(this, Widgets.APP_URL))
        }
    }
}
