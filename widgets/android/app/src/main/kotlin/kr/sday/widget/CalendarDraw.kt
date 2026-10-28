package kr.sday.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import java.time.LocalDate

/** 캘린더 위젯의 달력 그림: 요일, 가운데 맞춘 날짜, 그날 일정 이름을 한 줄씩 (줄 배경이 종류 파스텔 색, 끝낸 건 취소선) */
object CalendarDraw {
    private fun kindColor(kind: String) = when (kind) { "exam" -> R.color.kind_exam; "todo" -> R.color.kind_todo; else -> R.color.kind_assignment }

    /** 종류 색(기타는 정한 색). 파스텔 줄 배경 = 종류 색을 바탕색에 섞음, 글자 = 종류 색을 글자색에 섞음 */
    fun baseColor(ctx: Context, kind: String, hex: String?): Int =
        hex?.let { runCatching { android.graphics.Color.parseColor(it) }.getOrNull() } ?: ctx.getColor(kindColor(kind))

    fun mix(a: Int, b: Int, t: Float): Int {
        fun ch(sh: Int) = ((((a shr sh) and 255) * t + ((b shr sh) and 255) * (1 - t)).toInt().coerceIn(0, 255)) shl sh
        return (0xFF shl 24) or ch(16) or ch(8) or ch(0)
    }

    fun draw(ctx: Context, w: Int, h: Int, s: Float, month: LocalDate, today: LocalDate, items: Map<String, List<CalItem>>): Bitmap {
        val bmp = Bitmap.createBitmap(w.coerceAtLeast(50), h.coerceAtLeast(50), Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val first = month.withDayOfMonth(1)
        val start = first.minusDays((first.dayOfWeek.value % 7).toLong())       // 일요일 시작
        val weeks = ((first.dayOfWeek.value % 7) + first.lengthOfMonth() + 6) / 7

        val ink = ctx.getColor(R.color.ink); val faint = ctx.getColor(R.color.faint); val rule = ctx.getColor(R.color.rule)
        val pencil = ctx.getColor(R.color.pencil); val red = ctx.getColor(R.color.red); val pen = ctx.getColor(R.color.pen)
        val blue = ctx.getColor(R.color.saturday); val sheet = ctx.getColor(R.color.sheet)
        val dayColor = { i: Int -> when (i % 7) { 0 -> red; 6 -> blue; else -> ink } }
        val p = Paint(Paint.ANTI_ALIAS_FLAG)

        // 요일
        val colW = w / 7f
        val dowH = 18 * s
        p.textSize = 11 * s; p.textAlign = Paint.Align.CENTER; p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        "일월화수목금토".forEachIndexed { i, ch ->
            p.color = if (i == 0) red else if (i == 6) blue else pencil
            c.drawText(ch.toString(), colW * i + colW / 2, 12.5f * s, p)
        }
        val top = dowH
        val rowH = (h - top) / weeks
        p.color = rule; p.strokeWidth = maxOf(1f, 0.6f * s)
        for (r in 0 until weeks) c.drawLine(0f, top + rowH * r, w.toFloat(), top + rowH * r, p)

        val num = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12.5f * s; textAlign = Paint.Align.CENTER }
        val item = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * s; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
        val fill = Paint(Paint.ANTI_ALIAS_FLAG)
        val lineH = item.textSize * 1.38f
        val gap = 1.5f * s
        val pad = 1.5f * s
        for (i in 0 until weeks * 7) {
            val d = start.plusDays(i.toLong())
            val x0 = colW * (i % 7)
            val y0 = top + rowH * (i / 7)
            val cx = x0 + colW / 2
            val inMonth = d.monthValue == month.monthValue
            // 날짜: 칸 가운데 (오늘은 파란 동그라미)
            val numY = y0 + 3f * s + num.textSize
            if (d == today) {
                p.color = pen
                c.drawCircle(cx, numY - num.textSize * 0.36f, num.textSize * 0.92f, p)
            }
            num.color = if (d == today) 0xFFFFFFFF.toInt() else if (!inMonth) faint else dayColor(i)
            num.typeface = if (d == today) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
            num.alpha = if (inMonth || d == today) 255 else 150
            c.drawText(d.dayOfMonth.toString(), cx, numY, num)

            // 일정: 한 줄씩, 줄 배경이 종류 색 (칸에 다 안 들어가면 마지막 줄에 +n)
            val list = items[d.toString()] ?: continue
            var y = numY + 4f * s
            val room = ((y0 + rowH - pad - y) / (lineH + gap)).toInt().coerceAtLeast(0)
            val show = if (list.size > room) (room - 1).coerceAtLeast(0) else list.size
            for (it in list.take(show)) {
                // 지난 일정 · 다른 달도 종류 색(파스텔) 그대로. 끝낸 일정은 흐리게 + 취소선
                val base = baseColor(ctx, it.kind, it.color)
                fill.color = mix(base, sheet, 0.42f); fill.alpha = if (it.done) 160 else 255
                c.drawRoundRect(RectF(x0 + pad, y, x0 + colW - pad, y + lineH), 2.5f * s, 2.5f * s, fill)
                item.color = mix(base, ink, 0.5f); item.alpha = if (it.done) 170 else 255
                item.isStrikeThruText = it.done
                val text = TextUtils.ellipsize(it.title, item, colW - pad * 2 - 4f * s, TextUtils.TruncateAt.END)
                c.drawText(text, 0, text.length, x0 + pad + 2f * s, y + lineH * 0.76f, item)
                y += lineH + gap
            }
            if (show < list.size && room > 0) {
                item.color = pencil; item.alpha = 255; item.isStrikeThruText = false
                c.drawText("+${list.size - show}", x0 + pad + 2f * s, y + lineH * 0.76f, item)
            }
        }
        return bmp
    }
}
