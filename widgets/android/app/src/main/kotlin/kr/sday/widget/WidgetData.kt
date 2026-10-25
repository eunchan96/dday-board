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
)

data class Timer(
    val mode: String,
    val phase: String,
    val running: Boolean,
    val segStart: Long,
    val acc: Long,
    val label: String,
)

data class WidgetData(
    val upcoming: List<Task>,
    val todaySec: Long,
    val goalSec: Long,
    val timer: Timer?,
    val timerColor: String?,
    /** 캘린더 위젯: 날짜(yyyy-MM-dd) → 그날 일정들 (종류, 이름) */
    val month: Map<String, List<Pair<String, String>>> = emptyMap(),
    val stale: Boolean = false,
)

object Store {
    private const val PREFS = "sday"
    private const val KEY_URL = "url"
    private const val KEY_CACHE = "cache"

    fun url(ctx: Context): String = ctx.getSharedPreferences(PREFS, 0).getString(KEY_URL, "") ?: ""
    fun setUrl(ctx: Context, url: String) = ctx.getSharedPreferences(PREFS, 0).edit().putString(KEY_URL, url.trim()).apply()
    /** 위젯 배경 진하기 0~100 (%) */
    fun opacity(ctx: Context): Int = ctx.getSharedPreferences(PREFS, 0).getInt("opacity", 100)
    fun setOpacity(ctx: Context, v: Int) = ctx.getSharedPreferences(PREFS, 0).edit().putInt("opacity", v.coerceIn(0, 100)).apply()
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
        val month = mutableMapOf<String, MutableList<Pair<String, String>>>()
        o.optJSONArray("month")?.let { arr ->
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                month.getOrPut(m.optString("d")) { mutableListOf() }.add(m.optString("kind", "assignment") to m.optString("title"))
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
