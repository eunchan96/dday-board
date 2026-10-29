package kr.sday.widget

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import java.time.LocalDate
import java.time.ZoneId

/** 다가오는 일정 위젯의 목록 (스크롤되는 줄들). 내용은 위젯이 저장해 둔 캐시에서 읽는다 */
class UpcomingService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Row(val task: Task, val first: Boolean, val gap: Boolean)

    private class Factory(private val ctx: Context) : RemoteViewsFactory {
        private var rows: List<Row> = emptyList()
        private var pal = Palette.of(ctx, "upcoming")

        override fun onCreate() {}
        override fun onDestroy() {}
        override fun getCount() = rows.size
        override fun getViewTypeCount() = 1
        override fun getItemId(position: Int) = position.toLong()
        override fun hasStableIds() = false
        override fun getLoadingView(): RemoteViews? = null

        override fun onDataSetChanged() {
            pal = Palette.of(ctx, "upcoming")
            val data = Store.cache(ctx)?.let { runCatching { Api.parse(it) }.getOrNull() }
            var prev: String? = null
            rows = data?.upcoming.orEmpty().mapIndexed { i, t ->
                val day = t.day.ifBlank { t.due.atZone(SEOUL).toLocalDate().toString() }
                val first = day != prev
                prev = day
                Row(t.copy(day = day), first, first && i > 0)
            }
        }

        override fun getViewAt(position: Int): RemoteViews {
            val r = rows.getOrNull(position)
            val v = RemoteViews(ctx.packageName, R.layout.widget_row)
            if (r == null) return v
            val t = r.task
            val date = runCatching { LocalDate.parse(t.day) }.getOrNull()
            val today = LocalDate.now(SEOUL)
            // 그날 첫 줄에만 요일 (오늘은 파란 글씨, 일요일은 빨강) · 아래 작게 날짜
            if (r.first && date != null) {
                v.setTextViewText(R.id.wd, WEEK[date.dayOfWeek.value % 7])
                v.setTextViewText(R.id.date, "${date.monthValue}/${date.dayOfMonth}")
                v.setViewVisibility(R.id.date, View.VISIBLE)
                val wdColor = when {
                    date == today -> R.color.pen
                    date.dayOfWeek.value == 7 -> R.color.red
                    else -> R.color.ink
                }
                pal.paint(v, R.id.wd, "setTextColor", wdColor, always = wdColor != R.color.ink)
            } else {
                v.setTextViewText(R.id.wd, "")
                v.setViewVisibility(R.id.date, View.GONE)
            }
            pal.text(v, R.id.date, R.color.faint)
            // 날이 바뀌는 줄 위에 조금 띄움
            v.setViewPadding(R.id.row, 0, dp(if (r.gap) 9 else 3), 0, dp(3))
            v.setTextViewText(R.id.label, t.label)
            pal.paint(v, R.id.label, "setTextColor", if (t.missing) R.color.red else R.color.ink, always = t.missing)
            val light = CalendarDraw.baseColor(Palette.themed(ctx, false), t.kind, t.etcColor)
            val dark = CalendarDraw.baseColor(Palette.themed(ctx, true), t.kind, t.etcColor)
            pal.paintInt(v, R.id.bar, "setColorFilter", light, dark)
            v.setOnClickFillInIntent(R.id.row, Intent())
            return v
        }

        private fun dp(n: Int) = (n * ctx.resources.displayMetrics.density).toInt()
    }

    companion object {
        private val SEOUL = ZoneId.of("Asia/Seoul")
        private val WEEK = arrayOf("일", "월", "화", "수", "목", "금", "토")
    }
}
