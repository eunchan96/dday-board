package kr.sday.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * 위젯 세 가지 (각각 따로 홈 화면에 놓는다)
 *  - SdayWidget  : 다가오는 일정 (시험 빨강 · 과제 노랑 · 할 일 파랑 막대, 이름, D-day)
 *  - StudyWidget : 오늘 공부 시간과 목표
 *  - TimerWidget : 공부 중이면 흘러가는 타이머
 * 내용은 같은 주소에서 한 번 받아 셋이 나눠 쓴다.
 */
abstract class BaseWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        Widgets.render(ctx)             // 저장해 둔 내용으로 바로 그리고
        RefreshWorker.schedule(ctx)     // 15분마다 새로 받기
        RefreshWorker.now(ctx)
    }

    override fun onEnabled(ctx: Context) = RefreshWorker.schedule(ctx)
    override fun onDisabled(ctx: Context) { if (!Widgets.any(ctx)) RefreshWorker.cancel(ctx) }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action == Widgets.ACTION_REFRESH) RefreshWorker.now(ctx)
    }
}

class SdayWidget : BaseWidget()
class StudyWidget : BaseWidget()
class TimerWidget : BaseWidget()
class CalendarWidget : BaseWidget() {
    // 크기를 바꾸면 그 크기에 맞춰 다시 그림
    override fun onAppWidgetOptionsChanged(ctx: Context, manager: AppWidgetManager, id: Int, options: android.os.Bundle) = Widgets.render(ctx).let { }
}

object Widgets {
    const val ACTION_REFRESH = "kr.sday.widget.REFRESH"
    const val APP_URL = "https://dday-board-pink.vercel.app/"
    private val MODES = mapOf("p25" to (25 to 5), "p50" to (50 to 10))
    private val ROWS = listOf(
        arrayOf(R.id.row0, R.id.bar0, R.id.title0, R.id.dday0, R.id.sub0),
        arrayOf(R.id.row1, R.id.bar1, R.id.title1, R.id.dday1, R.id.sub1),
        arrayOf(R.id.row2, R.id.bar2, R.id.title2, R.id.dday2, R.id.sub2),
        arrayOf(R.id.row3, R.id.bar3, R.id.title3, R.id.dday3, R.id.sub3),
        arrayOf(R.id.row4, R.id.bar4, R.id.title4, R.id.dday4, R.id.sub4),
        arrayOf(R.id.row5, R.id.bar5, R.id.title5, R.id.dday5, R.id.sub5),
    )

    private fun ids(ctx: Context, cls: Class<*>) = AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, cls))
    fun any(ctx: Context) = listOf(SdayWidget::class.java, StudyWidget::class.java, TimerWidget::class.java, CalendarWidget::class.java).any { ids(ctx, it).isNotEmpty() }

    /** 배경 진하기 (앱에서 정한 값) */
    internal fun applyOpacity(ctx: Context, views: RemoteViews) =
        views.setInt(R.id.bg, "setImageAlpha", Store.opacity(ctx) * 255 / 100)

    private fun open(ctx: Context, hash: String, code: Int) = PendingIntent.getActivity(
        ctx, code, Intent(Intent.ACTION_VIEW, Uri.parse(APP_URL + hash)),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** 캐시된 내용(없으면 error 문구)으로 모든 위젯을 다시 그린다. 타이머가 끝나는 시각(ms)을 돌려줌 */
    fun render(ctx: Context, error: String? = null): Long? {
        val cached = Store.cache(ctx)
        val data = cached?.let { runCatching { Api.parse(it, stale = error != null) }.getOrNull() }
        val message = error ?: if (Store.url(ctx).isBlank()) "앱을 열어 위젯 주소를 넣어 주세요" else "불러오는 중…"
        val nowMs = System.currentTimeMillis()
        renderUpcoming(ctx, data, message, nowMs)
        renderStudy(ctx, data, nowMs)
        renderCalendar(ctx, data)
        return renderTimer(ctx, data, nowMs)
    }

    /* ───── 다가오는 일정 ───── */
    private fun renderUpcoming(ctx: Context, data: WidgetData?, message: String, nowMs: Long) {
        val ids = ids(ctx, SdayWidget::class.java)
        if (ids.isEmpty()) return
        val views = RemoteViews(ctx.packageName, R.layout.widget)
        applyOpacity(ctx, views)
        views.setOnClickPendingIntent(R.id.root, open(ctx, "#list", 0))
        val list = data?.upcoming.orEmpty()
        views.setViewVisibility(R.id.empty, if (list.isEmpty()) View.VISIBLE else View.GONE)
        views.setTextViewText(R.id.empty, if (data == null) message else "남은 일정이 없어요")
        val now = Instant.ofEpochMilli(nowMs)
        ROWS.forEachIndexed { i, r ->
            val task = list.getOrNull(i)
            if (task == null) { views.setViewVisibility(r[0], View.GONE); return@forEachIndexed }
            views.setViewVisibility(r[0], View.VISIBLE)
            val kindColor = when (task.kind) { "exam" -> R.color.kind_exam; "todo" -> R.color.kind_todo; else -> R.color.kind_assignment }
            views.setInt(r[1], "setColorFilter", ctx.getColor(kindColor))
            // 시험은 "중간고사"처럼 이름만 있는 경우가 많아 과목을 앞에 붙임 (접두어는 없음)
            val title = if (task.kind == "exam" && task.subject.isNotBlank() && !task.title.contains(task.subject)) "${task.subject} ${task.title}" else task.title
            views.setTextViewText(r[2], title)
            // 과제 · 할 일은 과목을 아래 작은 글씨로 (시험은 이름 앞에 이미 있음)
            val sub = if (task.kind != "exam") task.subject else ""
            views.setTextViewText(r[4], sub)
            views.setViewVisibility(r[4], if (sub.isBlank()) View.GONE else View.VISIBLE)
            val (label, late) = dday(task, now)
            views.setTextViewText(r[3], label)
            views.setTextColor(r[3], ctx.getColor(if (task.missing || late) R.color.red else R.color.ink))
        }
        AppWidgetManager.getInstance(ctx).updateAppWidget(ids, views)
    }

    /* ───── 캘린더: 이번 달 달력, 일정 있는 날 아래에 점 (시험 빨강 · 과제 노랑 · 할 일 파랑) ───── */
    private fun renderCalendar(ctx: Context, data: WidgetData?) {
        val manager = AppWidgetManager.getInstance(ctx)
        val ids = ids(ctx, CalendarWidget::class.java)
        for (id in ids) {
            val views = RemoteViews(ctx.packageName, R.layout.widget_calendar)
            applyOpacity(ctx, views)
            views.setOnClickPendingIntent(R.id.root, open(ctx, "#calendar", 4))
            val opts = manager.getAppWidgetOptions(id)
            val dm = ctx.resources.displayMetrics
            val wDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250).coerceAtLeast(110)
            val hDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 250).coerceAtLeast(110)
            // 위젯 안쪽 여백(12dp씩)을 빼고, 비트맵은 최대 2배 밀도까지만 (메모리 제한)
            val scale = minOf(dm.density, 2.5f)
            val bmp = CalendarDraw.draw(ctx, ((wDp - 24) * scale).toInt(), ((hDp - 24) * scale).toInt(), scale, data?.month.orEmpty())
            views.setImageViewBitmap(R.id.cal, bmp)
            manager.updateAppWidget(id, views)
        }
    }

    /* ───── 오늘 공부 ───── */
    private fun renderStudy(ctx: Context, data: WidgetData?, nowMs: Long) {
        val ids = ids(ctx, StudyWidget::class.java)
        if (ids.isEmpty()) return
        val views = RemoteViews(ctx.packageName, R.layout.widget_study)
        applyOpacity(ctx, views)
        views.setOnClickPendingIntent(R.id.root, open(ctx, "#study", 1))
        if (data == null) {
            views.setTextViewText(R.id.today, "—")
        } else {
            val t = data.timer
            var today = data.todaySec
            if (t != null && t.phase == "focus" && t.running && t.segStart > 0) today += (t.acc + nowMs - t.segStart) / 1000
            views.setTextViewText(R.id.today, spent(today))
        }
        AppWidgetManager.getInstance(ctx).updateAppWidget(ids, views)
    }

    /* ───── 타이머: 스톱워치는 올라가고, 25분 · 50분은 남은 시간이 내려간다 ───── */
    private fun renderTimer(ctx: Context, data: WidgetData?, nowMs: Long): Long? {
        val ids = ids(ctx, TimerWidget::class.java)
        if (ids.isEmpty()) return null
        val views = RemoteViews(ctx.packageName, R.layout.widget_timer)
        applyOpacity(ctx, views)
        views.setOnClickPendingIntent(R.id.root, open(ctx, "#study", 2))
        views.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(
            ctx, 3, Intent(ctx, TimerWidget::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ))
        var timerEnd: Long? = null
        var shown = false
        val t = data?.timer
        if (data != null && t != null && t.phase != "idle" && t.running && t.segStart > 0) {
            val elapsed = t.acc + nowMs - t.segStart
            val mode = MODES[t.mode]
            val color = when {
                t.phase == "rest" -> ctx.getColor(R.color.green)
                data.timerColor != null -> runCatching { Color.parseColor(data.timerColor) }.getOrDefault(ctx.getColor(R.color.pen))
                else -> ctx.getColor(R.color.pen)
            }
            views.setInt(R.id.timer_dot, "setColorFilter", color)
            views.setTextViewText(R.id.timer_label, if (t.phase == "rest") "쉬는 시간" else t.label.ifBlank { "공부 중" })
            if (mode == null) {
                views.setChronometerCountDown(R.id.timer, false)
                views.setChronometer(R.id.timer, SystemClock.elapsedRealtime() - elapsed, null, true)
                shown = true
            } else {
                val len = (if (t.phase == "rest") mode.second else mode.first) * 60_000L
                if (elapsed < len) {
                    views.setChronometerCountDown(R.id.timer, true)
                    views.setChronometer(R.id.timer, SystemClock.elapsedRealtime() + (len - elapsed), null, true)
                    timerEnd = nowMs + (len - elapsed)
                    shown = true
                }
            }
        }
        if (!shown) {
            views.setInt(R.id.timer_dot, "setColorFilter", ctx.getColor(R.color.rule))
            views.setTextViewText(R.id.timer_label, "타이머")
            views.setChronometer(R.id.timer, SystemClock.elapsedRealtime(), null, false)
        }
        views.setViewVisibility(R.id.timer, if (shown) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.idle, if (shown) View.GONE else View.VISIBLE)
        AppWidgetManager.getInstance(ctx).updateAppWidget(ids, views)
        return timerEnd
    }

    private fun spent(sec: Long): String {
        val m = sec / 60; val h = m / 60; val mm = m % 60
        return when { h > 0 && mm > 0 -> "${h}시간 ${mm}분"; h > 0 -> "${h}시간"; else -> "${mm}분" }
    }

    /** D-day 글자와 지났는지 */
    private fun dday(t: Task, now: Instant): Pair<String, Boolean> {
        val ms = Duration.between(now, t.due).toMillis()
        if (t.kind == "exam" && ms < 0) return "시험 중" to false
        if (ms < 0) return "지남" to true
        if (ms < 24 * 3600_000L) {
            val h = ms / 3600_000L
            return (if (h > 0) "${h}시간" else "${maxOf(1, ms / 60_000L)}분") to false
        }
        val zone = ZoneId.systemDefault()
        val days = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), t.due.atZone(zone).toLocalDate())
        return (if (days == 0L) "D-DAY" else "D-$days") to false
    }
}
