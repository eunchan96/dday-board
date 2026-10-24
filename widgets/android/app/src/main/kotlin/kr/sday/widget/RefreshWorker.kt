package kr.sday.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** 위젯 내용 새로 받기: 15분마다 + 새로 고침 버튼 + 타이머가 끝나는 때 */
class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val error = withContext(Dispatchers.IO) {
            try { Api.fetch(ctx); null } catch (e: WidgetError) { e.message } catch (e: Exception) { "불러오지 못했어요" }
        }
        val timerEnd = Widgets.render(ctx, error)
        // 25분 · 50분 타이머가 끝나면 한 번 더 새로 받아 화면을 맞춤
        if (timerEnd != null) {
            val delay = (timerEnd - System.currentTimeMillis()).coerceAtLeast(5_000L) + 5_000L
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                "sday-timer-end", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<RefreshWorker>().setInitialDelay(delay, TimeUnit.MILLISECONDS).build(),
            )
        }
        return Result.success()
    }

    companion object {
        private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                "sday-periodic", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(net).build(),
            )
        }

        fun now(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                "sday-now", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(net).build(),
            )
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork("sday-periodic")
            WorkManager.getInstance(ctx).cancelUniqueWork("sday-timer-end")
        }
    }
}
