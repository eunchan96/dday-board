package kr.sday.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import java.time.LocalDate
import java.time.ZoneId

/** 캘린더 위젯 그림: 머리줄(○월), 요일, 날짜, 일정 있는 날 아래 점 */
object CalendarDraw {
    private val KINDS = listOf("exam" to R.color.kind_exam, "assignment" to R.color.kind_assignment, "todo" to R.color.kind_todo)

    fun draw(ctx: Context, w: Int, h: Int, s: Float, month: Map<String, Set<String>>): Bitmap {
        val bmp = Bitmap.createBitmap(w.coerceAtLeast(50), h.coerceAtLeast(50), Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val today = LocalDate.now(ZoneId.of("Asia/Seoul"))
        val first = today.withDayOfMonth(1)
        val start = first.minusDays((first.dayOfWeek.value % 7).toLong())       // 일요일 시작
        val weeks = ((first.dayOfWeek.value % 7) + first.lengthOfMonth() + 6) / 7

        val ink = ctx.getColor(R.color.ink); val faint = ctx.getColor(R.color.faint)
        val pencil = ctx.getColor(R.color.pencil); val red = ctx.getColor(R.color.red); val pen = ctx.getColor(R.color.pen)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)

        // 머리줄
        val headH = 22 * s
        p.color = ink; p.textSize = 14 * s; p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        c.drawText("${today.monthValue}월", 2 * s, 15 * s, p)
        // 요일
        val colW = w / 7f
        val dowH = 16 * s
        p.textSize = 10 * s; p.typeface = Typeface.DEFAULT; p.textAlign = Paint.Align.CENTER
        "일월화수목금토".forEachIndexed { i, ch ->
            p.color = if (i == 0) red else pencil
            c.drawText(ch.toString(), colW * i + colW / 2, headH + 11 * s, p)
        }
        // 날짜
        val top = headH + dowH
        val rowH = (h - top) / weeks
        val num = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; textSize = minOf(12.5f * s, rowH * 0.42f) }
        val dot = Paint(Paint.ANTI_ALIAS_FLAG)
        val r = minOf(2.4f * s, rowH * 0.08f)
        for (i in 0 until weeks * 7) {
            val d = start.plusDays(i.toLong())
            val cx = colW * (i % 7) + colW / 2
            val cy = top + rowH * (i / 7) + rowH * 0.42f
            val inMonth = d.monthValue == today.monthValue
            if (d == today) {
                p.color = pen; p.style = Paint.Style.FILL
                c.drawCircle(cx, cy - num.textSize * 0.35f, num.textSize * 0.95f, p)
            }
            num.color = when { d == today -> 0xFFFFFFFF.toInt(); !inMonth -> faint; i % 7 == 0 -> red; else -> ink }
            num.typeface = if (d == today) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
            num.alpha = if (inMonth || d == today) 255 else 140
            c.drawText(d.dayOfMonth.toString(), cx, cy, num)
            val kinds = month[d.toString()] ?: continue
            val list = KINDS.filter { kinds.contains(it.first) }
            val gap = r * 3f
            var x = cx - gap * (list.size - 1) / 2
            val y = cy + num.textSize * 0.55f + r
            for ((_, color) in list) {
                dot.color = ctx.getColor(color); dot.alpha = if (inMonth) 255 else 120
                c.drawCircle(x, y, r, dot); x += gap
            }
        }
        return bmp
    }
}
