package org.bluecarbon.mrv.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.bluecarbon.mrv.BlueCarbonApp
import org.bluecarbon.mrv.data.api.CreateRecordRequest
import org.bluecarbon.mrv.data.db.AppDatabase
import java.io.File
import java.util.UUID

class SyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    private val db = AppDatabase.getDatabase(appContext)
    private val api = (appContext as BlueCarbonApp).apiService
    private val gson = Gson()

    override suspend fun doWork(): Result {
        return try {
            val pendingRecords = db.recordDao().getPendingRecords()

            for (record in pendingRecords) {
                var remoteId = record.remoteId

                // 1. Create remote record if not already created
                if (remoteId.isNullOrBlank()) {
                    val idempotencyKey = UUID.randomUUID().toString()
                    val measurementType = object : TypeToken<Map<String, Any>>() {}.type
                    val measurements: Map<String, Any> = gson.fromJson(record.measurementsJson, measurementType)

                    val req = CreateRecordRequest(
                        projectId = record.projectId,
                        activityDate = record.activityDate,
                        areaHa = record.areaHa,
                        ecosystemType = record.ecosystemType,
                        methodologyVersion = record.methodologyVersion,
                        measurements = measurements,
                        notes = record.notes
                    )

                    val resp = api.createRecord(idempotencyKey, req)
                    if (resp.isSuccessful && resp.body() != null) {
                        remoteId = resp.body()!!.record.id
                        db.recordDao().updateSyncStatus(record.localId, "SYNCING", remoteId)
                    } else {
                        return Result.retry()
                    }
                }

                // 2. Upload any pending evidence for this record
                val pendingEvidence = db.evidenceDao().getPendingEvidence().filter { it.localRecordId == record.localId }
                for (ev in pendingEvidence) {
                    val file = File(ev.filePath)
                    if (!file.exists()) {
                        db.evidenceDao().markUploaded(ev.id, "FILE_MISSING", null, null, null)
                        continue
                    }

                    val mediaType = ev.mimeType.toMediaTypeOrNull()
                    val requestFile = file.asRequestBody(mediaType)
                    val body = MultipartBody.Part.createFormData("file", ev.fileName, requestFile)

                    val pId = record.projectId.toRequestBody("text/plain".toMediaTypeOrNull())
                    val rId = remoteId.toRequestBody("text/plain".toMediaTypeOrNull())
                    val kind = ev.kind.toRequestBody("text/plain".toMediaTypeOrNull())
                    val cDate = ev.captureDate.toRequestBody("text/plain".toMediaTypeOrNull())
                    val sha = ev.sha256.toRequestBody("text/plain".toMediaTypeOrNull())
                    val lat = ev.latitude.toString().toRequestBody("text/plain".toMediaTypeOrNull())
                    val lon = ev.longitude.toString().toRequestBody("text/plain".toMediaTypeOrNull())
                    val acc = ev.accuracyMeters.toString().toRequestBody("text/plain".toMediaTypeOrNull())

                    val uploadResp = api.uploadEvidence(body, pId, rId, kind, cDate, sha, lat, lon, acc)
                    if (uploadResp.isSuccessful && uploadResp.body() != null) {
                        val evidenceDto = uploadResp.body()!!.evidence
                        db.evidenceDao().markUploaded(
                            id = ev.id,
                            status = "UPLOADED",
                            remoteId = evidenceDto.id,
                            cid = evidenceDto.ipfsCid,
                            scanStatus = evidenceDto.scanStatus
                        )
                    } else {
                        db.evidenceDao().markRetry(ev.id, "Upload failed: HTTP ${uploadResp.code()}")
                        return Result.retry()
                    }
                }

                // 3. If all evidence items are uploaded, submit record for verification
                val remainingUnsynced = db.evidenceDao().getUnsyncedEvidenceCount(record.localId)
                if (remainingUnsynced == 0 && !remoteId.isNullOrBlank()) {
                    val submitResp = api.submitRecord(remoteId)
                    if (submitResp.isSuccessful) {
                        db.recordDao().updateSyncStatus(record.localId, "SYNCED", remoteId)
                    }
                }
            }

            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
