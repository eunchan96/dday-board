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

class SdayWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        render(ctx)                     // 저장해 둔 내용으로 바로 그리고
        RefreshWorker.schedule(ctx)     // 15분마다 새로 받기
        RefreshWorker.now(ctx)
    }

    override fun onEnabled(ctx: Context) = RefreshWorker.schedule(ctx)
    override fun onDisabled(ctx: Context) = RefreshWorker.cancel(ctx)

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action == ACTION_REFRESH) RefreshWorker.now(ctx)
    }

    companion object {
        const val ACTION_REFRESH = "kr.sday.widget.REFRESH"
        const val APP_URL = "https://dday-board-pink.vercel.app/"
        private val MODES = mapOf("p25" to (25 to 5), "p50" to (50 to 10))
        private val ROWS = listOf(
            arrayOf(R.id.row0, R.id.bar0, R.id.title0, R.id.sub0, R.id.dday0),
            arrayOf(R.id.row1, R.id.bar1, R.id.title1, R.id.sub1, R.id.dday1),
            arrayOf(R.id.row2, R.id.bar2, R.id.title2, R.id.sub2, R.id.dday2),
            arrayOf(R.id.row3, R.id.bar3, R.id.title3, R.id.sub3, R.id.dday3),
        )

        /** 캐시된 내용(없으면 error 문구)으로 모든 위젯을 다시 그린다. 타이머가 끝나는 시각(ms)을 돌려줌 */
        fun render(ctx: Context, error: String? = null): Long? {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, SdayWidget::class.java))
            if (ids.isEmpty()) return null
            val cached = Store.cache(ctx)
            val data = cached?.let { runCatching { Api.parse(it, stale = error != null) }.getOrNull() }
            val views = RemoteViews(ctx.packageName, R.layout.widget)
            var timerEnd: Long? = null

            // 누르면 S-DAY 열기, 새로 고침 버튼
            val open = PendingIntent.getActivity(
                ctx, 0, Intent(Intent.ACTION_VIEW, Uri.parse(APP_URL)), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.root, open)
            val refresh = PendingIntent.getBroadcast(
                ctx, 1, Intent(ctx, SdayWidget::class.java).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.refresh, refresh)

            if (data == null) {
                views.setTextViewText(R.id.today, "—")
                views.setTextViewText(R.id.goal_text, "")
                views.setViewVisibility(R.id.empty, View.VISIBLE)
                views.setTextViewText(R.id.empty, error ?: if (Store.url(ctx).isBlank()) "앱을 열어 위젯 주소를 넣어 주세요" else "불러오는 중…")
                ROWS.forEach { views.setViewVisibility(it[0], View.GONE) }
                views.setViewVisibility(R.id.timer_row, View.GONE)
                views.setViewVisibility(R.id.timer, View.GONE)
                manager.updateAppWidget(ids, views)
                return null
            }

            val nowMs = System.currentTimeMillis()
            val now = Instant.ofEpochMilli(nowMs)

            // 오늘 공부 (공부 중이면 지금까지 더해서)
            val t = data.timer
            var today = data.todaySec
            if (t != null && t.phase == "focus" && t.running && t.segStart > 0) today += (t.acc + nowMs - t.segStart) / 1000
            views.setTextViewText(R.id.today, spent(today))
            if (data.goalSec > 0) {
                views.setViewVisibility(R.id.goal, View.VISIBLE)
                views.setProgressBar(R.id.goal, 100, ((today * 100) / data.goalSec).toInt().coerceIn(0, 100), false)
                views.setTextViewText(R.id.goal_text, "목표 ${spent(data.goalSec)}" + if (data.stale) " · 오프라인" else "")
            } else {
                views.setViewVisibility(R.id.goal, View.GONE)
                views.setTextViewText(R.id.goal_text, if (data.stale) "오프라인" else "")
            }

            // 타이머: 스톱워치는 올라가고, 25분 · 50분은 남은 시간이 내려간다 (위젯이 알아서 흘러감)
            val live = t != null && t.phase != "idle" && t.running && t.segStart > 0
            var shown = false
            if (live && t != null) {
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
            views.setViewVisibility(R.id.timer_row, if (shown) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.timer, if (shown) View.VISIBLE else View.GONE)

            // 다가오는 일정
            val list = data.upcoming
            views.setViewVisibility(R.id.empty, if (list.isEmpty()) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.empty, "남은 일정이 없어요")
            ROWS.forEachIndexed { i, r ->
                val task = list.getOrNull(i)
                if (task == null) { views.setViewVisibility(r[0], View.GONE); return@forEachIndexed }
                views.setViewVisibility(r[0], View.VISIBLE)
                val c = task.color?.let { runCatching { Color.parseColor(it) }.getOrNull() } ?: ctx.getColor(R.color.faint)
                views.setInt(r[1], "setColorFilter", c)
                val prefix = when (task.kind) { "exam" -> "시험 · "; "todo" -> "할 일 · "; else -> "" }
                val title = if (task.kind == "exam" && task.subject.isNotBlank() && !task.title.contains(task.subject)) "${task.subject} ${task.title}" else task.title
                views.setTextViewText(r[2], prefix + title)
                views.setTextViewText(r[3], listOf(task.subject, dueText(task.due)).filter { it.isNotBlank() }.joinToString(" · "))
                val (label, urgent) = dday(task, now)
                views.setTextViewText(r[4], label)
                views.setTextColor(r[4], ctx.getColor(if (task.missing || urgent) R.color.red else if (task.kind == "exam") R.color.exam else R.color.pencil))
            }
            manager.updateAppWidget(ids, views)
            return timerEnd
        }

        private fun spent(sec: Long): String {
            val m = sec / 60; val h = m / 60; val mm = m % 60
            return when { h > 0 && mm > 0 -> "${h}시간 ${mm}분"; h > 0 -> "${h}시간"; else -> "${mm}분" }
        }

        private fun dueText(due: Instant): String {
            val d = due.atZone(ZoneId.systemDefault())
            val w = "월화수목금토일"[d.dayOfWeek.value - 1]
            return "%d/%d(%s) %02d:%02d".format(d.monthValue, d.dayOfMonth, w, d.hour, d.minute)
        }

        /** D-day 글자와 급한지(하루 안 · 사흘 안) */
        private fun dday(t: Task, now: Instant): Pair<String, Boolean> {
            val ms = Duration.between(now, t.due).toMillis()
            if (t.kind == "exam" && ms < 0) return "시험 중" to false
            if (ms < 0) return "지남" to true
            if (ms < 24 * 3600_000L) {
                val h = ms / 3600_000L
                return (if (h > 0) "${h}시간" else "${maxOf(1, ms / 60_000L)}분") to true
            }
            val zone = ZoneId.systemDefault()
            val days = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), t.due.atZone(zone).toLocalDate())
            return (if (days == 0L) "D-DAY" else "D-$days") to (days <= 3)
        }
    }
}
