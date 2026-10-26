package org.bluecarbon.mrv

import android.app.Application
import com.google.gson.Gson
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import org.bluecarbon.mrv.data.api.AuthInterceptor
import org.bluecarbon.mrv.data.api.MrvApiService
import org.bluecarbon.mrv.data.db.AppDatabase
import org.bluecarbon.mrv.data.repository.*
import org.bluecarbon.mrv.sync.SyncManager
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

class BlueCarbonApp : Application() {

    lateinit var database: AppDatabase
        private set

    lateinit var apiService: MrvApiService
        private set

    lateinit var authRepository: AuthRepository
        private set

    lateinit var projectRepository: ProjectRepository
        private set

    lateinit var recordRepository: RecordRepository
        private set

    lateinit var evidenceRepository: EvidenceRepository
        private set

    override fun onCreate() {
        super.onCreate()

        database = AppDatabase.getDatabase(this)
        val gson = Gson()

        var currentTokenProvider: (() -> String?) = { null }

        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }

        val okHttpClient = OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor { currentTokenProvider() })
            .addInterceptor(logging)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()

        val retrofit = Retrofit.Builder()
            .baseUrl("http://10.0.2.2:4000/")
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()

        apiService = retrofit.create(MrvApiService::class.java)

        authRepository = AuthRepository(this, apiService)
        currentTokenProvider = { authRepository.getToken() }

        projectRepository = ProjectRepository(database.projectDao(), apiService, gson)
        recordRepository = RecordRepository(database.recordDao(), gson)
        evidenceRepository = EvidenceRepository(database.evidenceDao())

        // Schedule periodic background sync worker
        SyncManager.schedulePeriodicSync(this)
    }
}
