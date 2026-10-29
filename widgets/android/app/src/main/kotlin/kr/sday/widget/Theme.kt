package kr.sday.widget

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.widget.RemoteViews

/**
 * 위젯 화면 모드 (위젯 종류마다 따로): system = 폰 설정 따라 · light = 밝게 · dark = 어둡게
 *  - system: 레이아웃의 색(@color, values-night)이 그대로 폰 설정을 따른다. 코드에서 칠하는 색은
 *    안드로이드 12부터 밝을 때 · 어두울 때 색을 둘 다 넘겨서(setColorInt) 바로 바뀌게 한다
 *  - light / dark: 모든 색을 그 모드 값으로 직접 칠한다
 * 배경 진하기(투명도)는 모드와 상관없이 그대로 쓴다
 */
class Palette(ctx: Context, val mode: String) {
    private val light = themed(ctx, false)
    private val dark = themed(ctx, true)
    /** 지금 그리는 색 (system이면 지금 폰 설정 기준) */
    val now: Context = when (mode) {
        "light" -> light
        "dark" -> dark
        else -> if ((ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES) dark else light
    }
    val forced get() = mode != "system"
    val isDark get() = now === dark

    fun color(res: Int) = now.getColor(res)

    /** 글자색 · 아이콘 색 등을 칠함. system이면 레이아웃 색을 그대로 두고, always면 system이어도 칠함 */
    fun paint(views: RemoteViews, id: Int, method: String, res: Int, always: Boolean = false) =
        paintInt(views, id, method, light.getColor(res), dark.getColor(res), always)

    fun paintInt(views: RemoteViews, id: Int, method: String, lightColor: Int, darkColor: Int, always: Boolean = true) {
        when {
            mode == "light" -> views.setInt(id, method, lightColor)
            mode == "dark" -> views.setInt(id, method, darkColor)
            !always -> Unit
            Build.VERSION.SDK_INT >= 31 -> views.setColorInt(id, method, lightColor, darkColor)
            else -> views.setInt(id, method, if (isDark) darkColor else lightColor)
        }
    }

    fun text(views: RemoteViews, id: Int, res: Int) = paint(views, id, "setTextColor", res)

    companion object {
        fun themed(ctx: Context, night: Boolean): Context {
            val c = Configuration(ctx.resources.configuration)
            c.uiMode = (c.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
            return ctx.createConfigurationContext(c)
        }
        fun of(ctx: Context, kind: String) = Palette(ctx, Store.theme(ctx, kind))
    }
}
