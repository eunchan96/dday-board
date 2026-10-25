package kr.sday.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextUtils
import android.text.TextPaint
import java.time.LocalDate
import java.time.ZoneId

/** 캘린더 위젯 그림: 머리줄(○월), 요일, 날짜, 그날 일정 이름을 한 줄씩 (시험 빨강 · 과제 노랑 · 할 일 파랑 막대) */
object CalendarDraw {
    private fun kindColor(kind: String) = when (kind) { "exam" -> R.color.kind_exam; "todo" -> R.color.kind_todo; else -> R.color.kind_assignment }

    fun draw(ctx: Context, w: Int, h: Int, s: Float, month: Map<String, List<Pair<String, String>>>): Bitmap {
        val bmp = Bitmap.createBitmap(w.coerceAtLeast(50), h.coerceAtLeast(50), Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val today = LocalDate.now(ZoneId.of("Asia/Seoul"))
        val first = today.withDayOfMonth(1)
        val start = first.minusDays((first.dayOfWeek.value % 7).toLong())       // 일요일 시작
        val weeks = ((first.dayOfWeek.value % 7) + first.lengthOfMonth() + 6) / 7

        val ink = ctx.getColor(R.color.ink); val faint = ctx.getColor(R.color.faint); val rule = ctx.getColor(R.color.rule)
        val pencil = ctx.getColor(R.color.pencil); val red = ctx.getColor(R.color.red); val pen = ctx.getColor(R.color.pen)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)

        // 머리줄 · 요일
        val headH = 20 * s
        p.color = ink; p.textSize = 13 * s; p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        c.drawText("${today.monthValue}월", 2 * s, 14 * s, p)
        val colW = w / 7f
        val dowH = 14 * s
        p.textSize = 9.5f * s; p.typeface = Typeface.DEFAULT; p.textAlign = Paint.Align.CENTER
        "일월화수목금토".forEachIndexed { i, ch ->
            p.color = if (i == 0) red else pencil
            c.drawText(ch.toString(), colW * i + colW / 2, headH + 10 * s, p)
        }
        val top = headH + dowH
        val rowH = (h - top) / weeks
        // 칸 가로줄
        p.color = rule; p.strokeWidth = maxOf(1f, 0.6f * s)
        for (r in 0 until weeks) c.drawLine(0f, top + rowH * r, w.toFloat(), top + rowH * r, p)

        val num = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 9.5f * s }
        val item = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 8.5f * s; color = ink }
        val bar = Paint(Paint.ANTI_ALIAS_FLAG)
        val lineH = item.textSize * 1.32f
        val pad = 2.2f * s
        for (i in 0 until weeks * 7) {
            val d = start.plusDays(i.toLong())
            val x0 = colW * (i % 7)
            val y0 = top + rowH * (i / 7)
            val inMonth = d.monthValue == today.monthValue
            // 날짜 (오늘은 파란 동그라미)
            val numY = y0 + pad + num.textSize
            val nx = x0 + pad + 1 * s
            if (d == today) {
                p.color = pen
                val tw = num.measureText(d.dayOfMonth.toString())
                c.drawCircle(nx + tw / 2, numY - num.textSize * 0.35f, num.textSize * 0.85f, p)
            }
            num.color = when { d == today -> 0xFFFFFFFF.toInt(); !inMonth -> faint; i % 7 == 0 -> red; else -> ink }
            num.typeface = if (d == today) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
            c.drawText(d.dayOfMonth.toString(), nx, numY, num)
            // 일정 이름 한 줄씩 (칸에 다 안 들어가면 마지막 줄에 +n)
            val list = month[d.toString()] ?: continue
            var y = numY + 2.5f * s
            val room = ((y0 + rowH - pad - y) / lineH).toInt().coerceAtLeast(0)
            val show = if (list.size > room) (room - 1).coerceAtLeast(0) else list.size
            item.alpha = if (inMonth) 255 else 130
            for ((kind, title) in list.take(show)) {
                bar.color = ctx.getColor(kindColor(kind)); bar.alpha = item.alpha
                c.drawRoundRect(RectF(x0 + pad, y + lineH * 0.14f, x0 + pad + 2f * s, y + lineH * 0.86f), s, s, bar)
                val text = TextUtils.ellipsize(title, item, colW - pad * 2 - 4f * s, TextUtils.TruncateAt.END)
                c.drawText(text, 0, text.length, x0 + pad + 4f * s, y + item.textSize * 1.02f, item)
                y += lineH
            }
            if (show < list.size && room > 0) {
                item.color = pencil
                c.drawText("+${list.size - show}", x0 + pad + 4f * s, y + item.textSize * 1.02f, item)
                item.color = ink
            }
        }
        return bmp
    }
}
