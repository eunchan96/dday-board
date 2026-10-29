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

    /** task가 null이면 오늘 일정이 없다는 줄 */
    private class Row(val task: Task?, val day: String, val first: Boolean, val gap: Boolean)

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
            // 첫 줄은 늘 오늘 (오늘 일정이 없으면 "일정이 없어요")
            val today = LocalDate.now(SEOUL).toString()
            val list = data?.upcoming.orEmpty().map { t -> t.copy(day = t.day.ifBlank { t.due.atZone(SEOUL).toLocalDate().toString() }) }
                .filter { it.day >= today }
            val out = mutableListOf<Row>()
            if (data != null && list.firstOrNull()?.day != today) out += Row(null, today, true, false)
            var prev: String? = if (out.isEmpty()) null else today
            for (t in list) {
                val first = t.day != prev
                out += Row(t, t.day, first, first && out.isNotEmpty())
                prev = t.day
            }
            rows = out
        }

        override fun getViewAt(position: Int): RemoteViews {
            val r = rows.getOrNull(position)
            val v = RemoteViews(ctx.packageName, R.layout.widget_row)
            if (r == null) return v
            val t = r.task
            val date = runCatching { LocalDate.parse(r.day) }.getOrNull()
            val today = LocalDate.now(SEOUL)
            // 그날 첫 줄에만 "토 31" (오늘은 파란 글씨, 일요일은 빨강)
            if (r.first && date != null) {
                v.setTextViewText(R.id.wd, WEEK[date.dayOfWeek.value % 7])
                v.setTextViewText(R.id.date, date.dayOfMonth.toString())
                val wdColor = when {
                    date == today -> R.color.pen
                    date.dayOfWeek.value == 7 -> R.color.red
                    else -> R.color.ink
                }
                pal.paint(v, R.id.wd, "setTextColor", wdColor, always = wdColor != R.color.ink)
            } else {
                v.setTextViewText(R.id.wd, "")
                v.setTextViewText(R.id.date, "")
            }
            pal.text(v, R.id.date, R.color.faint)
            // 날이 바뀌는 줄 위에 조금 띄움
            v.setViewPadding(R.id.row, 0, dp(if (r.gap) 9 else 3), 0, dp(3))
            if (t == null) {
                v.setTextViewText(R.id.label, "일정이 없어요")
                pal.paint(v, R.id.label, "setTextColor", R.color.faint, always = true)
                v.setViewVisibility(R.id.bar, View.INVISIBLE)
            } else {
                v.setTextViewText(R.id.label, t.label)
                pal.paint(v, R.id.label, "setTextColor", if (t.missing) R.color.red else R.color.ink, always = t.missing)
                val light = CalendarDraw.baseColor(Palette.themed(ctx, false), t.kind, t.etcColor)
                val dark = CalendarDraw.baseColor(Palette.themed(ctx, true), t.kind, t.etcColor)
                pal.paintInt(v, R.id.bar, "setColorFilter", light, dark)
            }
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
