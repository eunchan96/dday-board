package kr.sday.widget

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/** S-DAY 위젯 주소에서 받은 내용 (설정 → 위젯의 /functions/v1/widget?k=…) */
data class Task(
    val kind: String,
    val title: String,
    val subject: String,
    val due: Instant,
    val missing: Boolean,
    val color: String?,
    val etcColor: String? = null,
)

data class Timer(
    val mode: String,
    val phase: String,
    val running: Boolean,
    val segStart: Long,
    val acc: Long,
    val label: String,
)

data class CalItem(val kind: String, val title: String, val done: Boolean, val color: String? = null)

data class WidgetData(
    val upcoming: List<Task>,
    val todaySec: Long,
    val goalSec: Long,
    val timer: Timer?,
    val timerColor: String?,
    /** 캘린더 위젯: 날짜(yyyy-MM-dd) → 그날 일정들 */
    val month: Map<String, List<CalItem>> = emptyMap(),
    val stale: Boolean = false,
)

object Store {
    private const val PREFS = "sday"
    private const val KEY_URL = "url"
    private const val KEY_CACHE = "cache"

    fun url(ctx: Context): String = ctx.getSharedPreferences(PREFS, 0).getString(KEY_URL, "") ?: ""
    fun setUrl(ctx: Context, url: String) = ctx.getSharedPreferences(PREFS, 0).edit().putString(KEY_URL, url.trim()).apply()
    /** 위젯 배경 진하기 0~100 (%) */
    /** 위젯 종류: 키 → 이름 */
    val KINDS = listOf("study" to "오늘 공부", "timer" to "타이머", "upcoming" to "다가오는 일정", "calendar" to "캘린더")
    /** 위젯마다 배경 진하기 (따로 정하지 않았으면 예전에 정한 공통 값, 그것도 없으면 100) */
    fun opacity(ctx: Context, kind: String): Int {
        val p = ctx.getSharedPreferences(PREFS, 0)
        return p.getInt("opacity_$kind", p.getInt("opacity", 100))
    }
    fun setOpacity(ctx: Context, kind: String, v: Int) =
        ctx.getSharedPreferences(PREFS, 0).edit().putInt("opacity_$kind", v.coerceIn(0, 100)).apply()
    /** 캘린더 위젯에서 넘겨 본 달 (0 = 이번 달) */
    fun calOffset(ctx: Context): Int = ctx.getSharedPreferences(PREFS, 0).getInt("calOffset", 0)
    fun setCalOffset(ctx: Context, v: Int) = ctx.getSharedPreferences(PREFS, 0).edit().putInt("calOffset", v.coerceIn(-3, 6)).apply()
    fun cache(ctx: Context): String? = ctx.getSharedPreferences(PREFS, 0).getString(KEY_CACHE, null)
    fun setCache(ctx: Context, json: String) = ctx.getSharedPreferences(PREFS, 0).edit().putString(KEY_CACHE, json).apply()

    /** 위젯 주소 모양인지 (https · /functions/v1/widget · k=) */
    fun looksValid(url: String): Boolean =
        Regex("""^https://[^\s/]+/functions/v1/widget\?k=[A-Za-z0-9_-]{20,64}$""").matches(url.trim())
}

class WidgetError(message: String) : Exception(message)

object Api {
    /** 네트워크에서 받아 캐시에 저장하고 돌려준다. 실패하면 WidgetError */
    fun fetch(ctx: Context): String {
        val url = Store.url(ctx)
        if (url.isBlank()) throw WidgetError("앱을 열어 위젯 주소를 넣어 주세요")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = conn.responseCode
            if (code == 404) throw WidgetError("위젯 주소가 바뀌었어요. 앱을 열어 새 주소를 넣어 주세요")
            if (code !in 200..299) throw WidgetError("잠시 후 다시 시도해요 ($code)")
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            parse(body) // 모양 확인
            Store.setCache(ctx, body)
            return body
        } finally {
            conn.disconnect()
        }
    }

    fun parse(body: String, stale: Boolean = false): WidgetData {
        val o = JSONObject(body)
        val list = o.optJSONArray("upcoming")
        val tasks = buildList {
            if (list != null) for (i in 0 until list.length()) {
                val t = list.getJSONObject(i)
                add(
                    Task(
                        kind = t.optString("kind", "assignment"),
                        title = t.optString("title"),
                        subject = t.optString("subject"),
                        due = Instant.parse(t.getString("due")),
                        missing = t.optBoolean("missing", false),
                        color = if (t.isNull("color")) null else t.optString("color"),
                        etcColor = if (t.isNull("c")) null else t.optString("c"),
                    )
                )
            }
        }
        val study = o.optJSONObject("study") ?: JSONObject()
        val tj = study.optJSONObject("timer")
        val timer = tj?.let {
            Timer(
                mode = it.optString("mode", "watch"),
                phase = it.optString("phase", "idle"),
                running = it.optBoolean("running", false),
                segStart = it.optLong("segStart", 0L),
                acc = it.optLong("acc", 0L),
                label = it.optString("label").ifBlank { it.optString("subject") },
            )
        }
        val month = mutableMapOf<String, MutableList<CalItem>>()
        o.optJSONArray("month")?.let { arr ->
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                month.getOrPut(m.optString("d")) { mutableListOf() }.add(CalItem(m.optString("kind", "assignment"), m.optString("title"), m.optBoolean("done", false), if (m.isNull("c")) null else m.optString("c")))
            }
        }
        return WidgetData(
            month = month,
            upcoming = tasks,
            todaySec = study.optLong("today", 0L),
            goalSec = study.optLong("goal", 0L),
            timer = timer,
            timerColor = if (study.isNull("timerColor")) null else study.optString("timerColor"),
            stale = stale,
        )
    }
}
