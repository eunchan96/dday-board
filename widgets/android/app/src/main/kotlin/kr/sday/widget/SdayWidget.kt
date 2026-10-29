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
        if (intent.action == Widgets.ACTION_REFRESH) {
            val done = goAsync()
            Widgets.setSyncing(ctx, true)
            Thread {
                val error = try { Api.fetch(ctx); null } catch (e: WidgetError) { e.message } catch (e: Exception) { "불러오지 못했어요" }
                Widgets.setSyncing(ctx, false)
                Widgets.render(ctx, error)
                done.finish()
            }.start()
        }
        // 캘린더 위젯의 ‹ › · 오늘: 보는 달만 바꿔 다시 그림 (인터넷 없이)
        if (intent.action == Widgets.ACTION_CAL) {
            val shift = intent.getIntExtra("shift", 0)
            Store.setCalOffset(ctx, if (shift == 0) 0 else Store.calOffset(ctx) + shift)
            Widgets.render(ctx)
        }
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
    const val ACTION_CAL = "kr.sday.widget.CAL"
    const val APP_URL = "https://dday-board-pink.vercel.app/"
    private val MODES = mapOf("p25" to (25 to 5), "p50" to (50 to 10))

    private fun ids(ctx: Context, cls: Class<*>) = AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, cls))
    fun any(ctx: Context) = listOf(SdayWidget::class.java, StudyWidget::class.java, TimerWidget::class.java, CalendarWidget::class.java).any { ids(ctx, it).isNotEmpty() }

    /** 배경 진하기(앱에서 정한 값)와 화면 모드. 밝게 · 어둡게로 정했으면 배경과 새로 고침 아이콘도 그 색으로 */
    internal fun applyOpacity(ctx: Context, views: RemoteViews, kind: String): Palette {
        views.setInt(R.id.bg, "setImageAlpha", Store.opacity(ctx, kind) * 255 / 100)
        val pal = Palette.of(ctx, kind)
        pal.paint(views, R.id.bg, "setColorFilter", R.color.sheet)
        pal.paint(views, R.id.refresh, "setColorFilter", R.color.faint)
        return pal
    }

    private fun open(ctx: Context, hash: String, code: Int) = PendingIntent.getActivity(
        ctx, code, Intent(ctx, OpenActivity::class.java).putExtra("url", APP_URL + hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    /** 위젯마다 있는 새로 고침 버튼 */
    private fun refresh(ctx: Context, code: Int) = PendingIntent.getBroadcast(
        ctx, code, Intent(ctx, SdayWidget::class.java).setAction(ACTION_REFRESH),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    @Volatile private var syncing = false
    fun setSyncing(ctx: Context, on: Boolean) { syncing = on; if (on) render(ctx) }
    private fun paintRefresh(views: RemoteViews) = views.setFloat(R.id.refresh, "setAlpha", if (syncing) 0.25f else 0.6f)

    /**
     * 위젯을 눌렀을 때 열 곳 (누르는 순간에 찾음)
     *  1) 홈 화면에 설치한 S-DAY 앱 (크롬이 만든 WebAPK)
     *  2) 없으면 이 앱 안에서 S-DAY를 앱처럼 띄움 (TWA: 기본 브라우저가 주소창 없이 전체 화면, 그 브라우저에 저장된 보드 그대로)
     */
    fun appIntent(ctx: Context, url: String): Intent {
        val pm = ctx.packageManager
        findApp(ctx)?.let { pkg ->
            val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (i.resolveActivity(pm) != null) return i
            pm.getLaunchIntentForPackage(pkg)?.let { return it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        }
        return twaIntent(ctx, url)
    }
    fun twaIntent(ctx: Context, url: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .setClassName(ctx, "com.google.androidbrowserhelper.trusted.LauncherActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    /** TWA로 띄울 브라우저 이름 */
    fun twaBrowser(ctx: Context): String? = runCatching {
        val pkg = com.google.androidbrowserhelper.trusted.TwaProviderPicker.pickProvider(ctx.packageManager).provider ?: return null
        ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrNull()

    private val SAMSUNG = listOf("com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta")

    /** S-DAY 주소를 열 수 있다고 한 앱들 (브라우저 포함) */
    fun handlers(ctx: Context, url: String = APP_URL): List<String> = runCatching {
        ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_VIEW, Uri.parse(url)), android.content.pm.PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName }.distinct()
    }.getOrDefault(emptyList())

    /** 설치된 S-DAY 앱(WebAPK) 패키지 이름. 없으면 null */
    fun findApp(ctx: Context): String? {
        val pm = ctx.packageManager
        val host = Uri.parse(APP_URL).host ?: return null
        return runCatching {
            // 1) 시작 주소 · 범위 메타데이터가 S-DAY인 앱 (크롬 WebAPK)
            pm.getInstalledApplications(android.content.pm.PackageManager.GET_META_DATA).firstOrNull { app ->
                if (app.packageName == ctx.packageName) return@firstOrNull false
                val md = app.metaData ?: return@firstOrNull false
                md.keySet().any { k -> (md.get(k)?.toString() ?: "").contains(host) }
            }?.packageName
            // 2) S-DAY 주소는 받는데 다른 주소(example.com)는 안 받는 앱 = 브라우저가 아닌 S-DAY 앱
                ?: (handlers(ctx) - handlers(ctx, "https://example.com/").toSet() - ctx.packageName).firstOrNull()
        }.getOrNull()
    }

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

    /* ───── 다가오는 일정: 앞으로 2주, 요일별로 묶은 목록(스크롤) ───── */
    private fun renderUpcoming(ctx: Context, data: WidgetData?, message: String, nowMs: Long) {
        val manager = AppWidgetManager.getInstance(ctx)
        val ids = ids(ctx, SdayWidget::class.java)
        if (ids.isEmpty()) return
        for (id in ids) {
            val views = RemoteViews(ctx.packageName, R.layout.widget)
            val pal = applyOpacity(ctx, views, "upcoming")
            views.setOnClickPendingIntent(R.id.refresh, refresh(ctx, 20)); paintRefresh(views)
            views.setOnClickPendingIntent(R.id.root, open(ctx, "#list", 0))
            // 목록: 줄마다 같은 곳(#list)을 연다
            views.setRemoteAdapter(R.id.list, Intent(ctx, UpcomingService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .also { it.data = Uri.parse(it.toUri(Intent.URI_INTENT_SCHEME)) })
            views.setPendingIntentTemplate(R.id.list, PendingIntent.getActivity(
                ctx, 30, Intent(ctx, OpenActivity::class.java).putExtra("url", APP_URL + "#list").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or (if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)))
            views.setEmptyView(R.id.list, R.id.empty)
            // 목록은 첫 줄이 늘 오늘이라 비는 건 아직 못 받았을 때뿐
            views.setTextViewText(R.id.empty, message)
            pal.text(views, R.id.empty, R.color.faint)
            manager.updateAppWidget(id, views)
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.list)
    }

    /* ───── 캘린더: 이번 달 달력, 일정 있는 날 아래에 점 (시험 빨강 · 과제 노랑 · 할 일 파랑) ───── */
    private fun renderCalendar(ctx: Context, data: WidgetData?) {
        val manager = AppWidgetManager.getInstance(ctx)
        val ids = ids(ctx, CalendarWidget::class.java)
        if (ids.isEmpty()) return
        val today = java.time.LocalDate.now(ZoneId.of("Asia/Seoul"))
        val month = today.withDayOfMonth(1).plusMonths(Store.calOffset(ctx).toLong())
        val shift = { code: Int, by: Int -> PendingIntent.getBroadcast(
            ctx, code, Intent(ctx, CalendarWidget::class.java).setAction(ACTION_CAL).putExtra("shift", by),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        for (id in ids) {
            val views = RemoteViews(ctx.packageName, R.layout.widget_calendar)
            val pal = applyOpacity(ctx, views, "calendar")
            pal.text(views, R.id.cal_month, R.color.ink)
            pal.text(views, R.id.cal_today, R.color.ink)
            for (icon in intArrayOf(R.id.cal_prev, R.id.cal_next, R.id.cal_add)) pal.paint(views, icon, "setColorFilter", R.color.ink)
            if (pal.forced) views.setInt(R.id.cal_today, "setBackgroundResource", if (pal.isDark) R.drawable.today_box_dark else R.drawable.today_box_light)
            views.setOnClickPendingIntent(R.id.refresh, refresh(ctx, 22)); paintRefresh(views)
            views.setTextViewText(R.id.cal_month, if (month.year == today.year) "${month.monthValue}월" else "${month.year}년 ${month.monthValue}월")
            views.setTextViewText(R.id.cal_today, today.dayOfMonth.toString())
            views.setOnClickPendingIntent(R.id.cal_prev, shift(10, -1))
            views.setOnClickPendingIntent(R.id.cal_next, shift(11, 1))
            views.setOnClickPendingIntent(R.id.cal_today, shift(12, 0))
            views.setOnClickPendingIntent(R.id.cal_add, open(ctx, "#new", 13))
            views.setOnClickPendingIntent(R.id.cal, open(ctx, "#calendar", 4))
            val opts = manager.getAppWidgetOptions(id)
            val dm = ctx.resources.displayMetrics
            val wDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250).coerceAtLeast(110)
            val hDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 250).coerceAtLeast(110)
            // 위젯 안쪽 여백과 머리줄(40dp)을 빼고, 비트맵은 최대 2.5배 밀도까지만 (메모리 제한)
            val scale = minOf(dm.density, 2.5f)
            val bw = ((wDp - 16) * scale).toInt(); val bh = ((hDp - 54) * scale).toInt()
            val items = data?.month.orEmpty()
            // 그림은 정한 모드(폰 설정 따라면 지금 폰 모드)로 하나만 (두 장을 넣으면 위젯을 못 올리는 폰이 있음)
            views.setImageViewBitmap(R.id.cal, CalendarDraw.draw(pal.now, bw, bh, scale, month, today, items))
            manager.updateAppWidget(id, views)
        }
    }

    /* ───── 오늘 공부 ───── */
    private fun renderStudy(ctx: Context, data: WidgetData?, nowMs: Long) {
        val ids = ids(ctx, StudyWidget::class.java)
        if (ids.isEmpty()) return
        val views = RemoteViews(ctx.packageName, R.layout.widget_study)
        val pal = applyOpacity(ctx, views, "study")
        pal.text(views, R.id.label, R.color.pencil)
        pal.text(views, R.id.today, R.color.ink)
        views.setOnClickPendingIntent(R.id.refresh, refresh(ctx, 21)); paintRefresh(views)
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
        val pal = applyOpacity(ctx, views, "timer")
        pal.text(views, R.id.timer_label, R.color.pencil)
        pal.text(views, R.id.timer, R.color.ink)
        pal.text(views, R.id.idle, R.color.faint)
        views.setOnClickPendingIntent(R.id.root, open(ctx, "#study", 2))
        views.setOnClickPendingIntent(R.id.refresh, refresh(ctx, 3)); paintRefresh(views)
        var timerEnd: Long? = null
        var shown = false
        val t = data?.timer
        if (data != null && t != null && t.phase != "idle" && t.running && t.segStart > 0) {
            val elapsed = t.acc + nowMs - t.segStart
            val mode = MODES[t.mode]
            val color = when {
                t.phase == "rest" -> pal.color(R.color.green)
                data.timerColor != null -> runCatching { Color.parseColor(data.timerColor) }.getOrDefault(pal.color(R.color.pen))
                else -> pal.color(R.color.pen)
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
            pal.paint(views, R.id.timer_dot, "setColorFilter", R.color.rule, always = true)
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
}
