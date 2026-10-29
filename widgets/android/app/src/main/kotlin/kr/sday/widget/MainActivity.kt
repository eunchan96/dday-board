package kr.sday.widget

import android.app.Activity
import android.content.ClipboardManager
import android.content.res.ColorStateList
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * 위젯 앱 첫 화면
 *  - 연결: S-DAY 설정 → 위젯에서 복사한 주소를 붙여 넣고 연결 (연결되면 주소 칸은 숨기고 "주소 바꾸기")
 *  - 위젯 모양: 위젯마다 배경 진하기와 화면 모드(자동 · 밝게 · 어둡게)
 */
class MainActivity : Activity() {
    private lateinit var url: EditText
    private lateinit var status: TextView
    private var editing = false

    // 이 앱을 열 때마다 위젯 내용도 새로 받기
    override fun onResume() {
        super.onResume()
        if (Store.url(this).isNotBlank()) RefreshWorker.now(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        url = findViewById(R.id.url)
        status = findViewById(R.id.status)
        url.setText(Store.url(this))
        showConnection(null)

        findViewById<TextView>(R.id.change).setOnClickListener { editing = true; showConnection(null) }
        // 붙여 넣고 연결: 칸이 비어 있으면 복사한 내용을 넣고 바로 확인
        findViewById<Button>(R.id.connect).setOnClickListener {
            if (url.text.isBlank()) {
                val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
                val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
                url.setText(text)
            }
            connect(url.text.toString().trim())
        }

        buildLooks()

        findViewById<Button>(R.id.open).setOnClickListener { startActivity(Widgets.appIntent(this, Widgets.APP_URL)) }
        // 위젯을 누르면 어디로 열리는지 (한 줄)
        val app = Widgets.findApp(this)
        findViewById<TextView>(R.id.open_target).text =
            if (app != null) "위젯을 누르면 설치한 S-DAY 앱으로 열려요"
            else "위젯을 누르면 ${Widgets.twaBrowser(this) ?: "브라우저"}에서 S-DAY 앱 화면으로 열려요"
    }

    private fun connect(value: String) {
        if (!Store.looksValid(value)) {
            status.text = "위젯 주소가 아니에요. S-DAY 설정 → 위젯에서 복사해 주세요."
            status.setTextColor(getColor(R.color.red))
            return
        }
        Store.setUrl(this, value)
        status.setTextColor(getColor(R.color.pencil))
        status.text = "확인하는 중…"
        thread {
            val result = runCatching { Api.parse(Api.fetch(this)) }
            runOnUiThread {
                result.onSuccess { editing = false; showConnection(it.upcoming.size) }
                    .onFailure { e ->
                        status.text = (e as? WidgetError)?.message ?: "불러오지 못했어요. 인터넷 연결을 확인해 주세요."
                        status.setTextColor(getColor(R.color.red))
                    }
                Widgets.render(this)
                RefreshWorker.schedule(this)
            }
        }
    }

    /** 연결 카드: 연결됨이면 한 줄 안내만, 아니면 주소 칸 + 버튼 */
    private fun showConnection(count: Int?) {
        val connected = Store.url(this).isNotBlank()
        val dot = findViewById<ImageView>(R.id.conn_dot)
        dot.imageTintList = ColorStateList.valueOf(getColor(if (connected) R.color.green else R.color.faint))
        findViewById<TextView>(R.id.conn_title).text = if (connected) "연결됨" else "연결 안 됨"
        findViewById<TextView>(R.id.change).visibility = if (connected && !editing) View.VISIBLE else View.GONE
        findViewById<View>(R.id.url_box).visibility = if (!connected || editing) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.connect).text = if (editing) "연결" else "붙여 넣고 연결"
        status.setTextColor(getColor(R.color.pencil))
        status.text = when {
            !connected -> "S-DAY 설정 → 위젯에서 주소를 복사해 오세요."
            editing -> "새 주소를 넣고 연결을 눌러 주세요."
            count != null -> "다가오는 일정 ${count}개를 받았어요. 홈 화면을 길게 눌러 위젯 → S-DAY에서 추가하세요."
            else -> "홈 화면을 길게 눌러 위젯 → S-DAY에서 추가하세요."
        }
    }

    /** 위젯 모양: 위젯마다 이름 · 진하기(%) 한 줄, 막대, 화면 모드 세 칸 */
    private fun buildLooks() {
        val box = findViewById<LinearLayout>(R.id.opacity_box)
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        Store.KINDS.forEachIndexed { i, (kind, name) ->
            if (i > 0) box.addView(View(this).apply {
                setBackgroundColor(getColor(R.color.rule))
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxOf(1, px(1) / 2))
            })
            val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, px(16), 0, 0) }
            val title = TextView(this).apply { text = name; textSize = 15f; setTextColor(getColor(R.color.ink)); paint.isFakeBoldText = true }
            val value = TextView(this).apply { textSize = 13f; setTextColor(getColor(R.color.pencil)); gravity = Gravity.END }
            head.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            head.addView(value)
            fun show(v: Int) { value.text = if (v == 0) "배경 없음" else "배경 $v%" }
            show(Store.opacity(this, kind))

            val bar = SeekBar(this).apply {
                max = 10; progress = Store.opacity(this@MainActivity, kind) / 10
                progressTintList = ColorStateList.valueOf(getColor(R.color.pen))
                thumbTintList = ColorStateList.valueOf(getColor(R.color.pen))
                progressBackgroundTintList = ColorStateList.valueOf(getColor(R.color.rule))
                setPadding(px(2), px(10), px(2), px(10))
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(b: SeekBar, v: Int, fromUser: Boolean) {
                        if (!fromUser) return
                        Store.setOpacity(this@MainActivity, kind, v * 10); show(v * 10); Widgets.render(this@MainActivity)
                    }
                    override fun onStartTrackingTouch(b: SeekBar) {}
                    override fun onStopTrackingTouch(b: SeekBar) {}
                })
            }

            // 화면 모드: 자동(폰 설정 따라) · 밝게 · 어둡게
            val seg = RadioGroup(this).apply {
                orientation = RadioGroup.HORIZONTAL
                setBackgroundResource(R.drawable.seg_bg)
                setPadding(px(3), px(3), px(3), px(3))
            }
            for ((v, text) in listOf("system" to "자동", "light" to "밝게", "dark" to "어둡게")) {
                val rb = RadioButton(this).apply {
                    id = View.generateViewId(); this.text = text; textSize = 13.5f; gravity = Gravity.CENTER
                    buttonDrawable = null; setBackgroundResource(R.drawable.seg_item)
                    setTextColor(getColorStateList(R.color.seg_text))
                    isChecked = Store.theme(this@MainActivity, kind) == v
                    setOnCheckedChangeListener { _, on -> if (on) { Store.setTheme(this@MainActivity, kind, v); Widgets.render(this@MainActivity) } }
                }
                seg.addView(rb, RadioGroup.LayoutParams(0, px(34), 1f))
            }
            box.addView(head)
            box.addView(bar)
            box.addView(seg, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = px(16) })
        }
    }
}
