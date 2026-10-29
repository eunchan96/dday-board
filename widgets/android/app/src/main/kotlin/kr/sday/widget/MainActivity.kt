package kr.sday.widget

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.view.View
import kotlin.concurrent.thread

/** 위젯 주소를 넣는 화면 (S-DAY 설정 → 위젯에서 복사한 주소) */
class MainActivity : Activity() {

    // 이 앱을 열 때마다 위젯 내용도 새로 받기
    override fun onResume() {
        super.onResume()
        if (Store.url(this).isNotBlank()) RefreshWorker.now(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val url = findViewById<EditText>(R.id.url)
        val status = findViewById<TextView>(R.id.status)
        url.setText(Store.url(this))
        if (Store.url(this).isNotBlank()) status.text = "저장된 주소가 있어요. 홈 화면에 S-DAY 위젯을 추가하세요."
        // 위젯을 누르면 어디로 열리는지 (설치한 S-DAY 앱을 찾았는지) 보여 줌
        val target = findViewById<TextView>(R.id.open_target)
        val app = Widgets.findApp(this)
        val handlers = Widgets.handlers(this).filter { it != packageName }
        val names = handlers.joinToString(", ") { pkg -> runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg) }
        target.text = when {
            app != null -> "위젯을 누르면: 설치한 S-DAY 앱 ($app)"
            packageManager.getLaunchIntentForPackage("com.sec.android.app.sbrowser") != null -> "위젯을 누르면: 삼성 인터넷 (설치한 S-DAY 앱을 찾지 못했어요)"
            else -> "위젯을 누르면: 기본 브라우저 (설치한 S-DAY 앱을 찾지 못했어요)"
        } + if (names.isNotBlank()) "\nS-DAY 주소를 열 수 있는 앱: $names" else ""

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

        // 배경 진하기: 위젯 종류마다 0~100%를 10단계로
        val box = findViewById<LinearLayout>(R.id.opacity_box)
        val dp = resources.displayMetrics.density
        for ((kind, name) in Store.KINDS) {
            val label = TextView(this).apply {
                textSize = 14f; setTextColor(getColor(R.color.ink)); setPadding(0, (14 * dp).toInt(), 0, 0)
            }
            fun show(v: Int) { label.text = "$name  $v%" }
            show(Store.opacity(this, kind))
            val bar = SeekBar(this).apply {
                max = 10; progress = Store.opacity(this@MainActivity, kind) / 10
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(b: SeekBar, value: Int, fromUser: Boolean) {
                        if (!fromUser) return
                        Store.setOpacity(this@MainActivity, kind, value * 10)
                        show(value * 10)
                        Widgets.render(this@MainActivity)
                    }
                    override fun onStartTrackingTouch(b: SeekBar) {}
                    override fun onStopTrackingTouch(b: SeekBar) {}
                })
            }
            // 화면 모드: 폰 설정 따라 · 밝게 · 어둡게 (위젯마다)
            val group = android.widget.RadioGroup(this).apply { orientation = android.widget.RadioGroup.HORIZONTAL }
            for ((value, text) in listOf("system" to "폰 설정 따라", "light" to "밝게", "dark" to "어둡게")) {
                val rb = android.widget.RadioButton(this).apply {
                    id = View.generateViewId(); this.text = text; textSize = 13f; setTextColor(getColor(R.color.pencil))
                    isChecked = Store.theme(this@MainActivity, kind) == value
                    setOnCheckedChangeListener { _, on -> if (on) { Store.setTheme(this@MainActivity, kind, value); Widgets.render(this@MainActivity) } }
                }
                group.addView(rb)
            }
            box.addView(label); box.addView(bar); box.addView(group)
        }

        findViewById<Button>(R.id.open).setOnClickListener {
            startActivity(Widgets.appIntent(this, Widgets.APP_URL))
        }
    }
}
