package org.bluecarbon.mrv.data.repository

import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import org.bluecarbon.mrv.data.db.LocalRecord
import org.bluecarbon.mrv.data.db.RecordDao
import java.util.UUID

class RecordRepository(
    private val recordDao: RecordDao,
    private val gson: Gson
) {
    val records: Flow<List<LocalRecord>> = recordDao.getAllRecords()

    suspend fun createDraft(
        projectId: String,
        projectCode: String,
        activityDate: String,
        areaHa: Double,
        ecosystemType: String,
        methodologyVersion: String = "IPCC-WS2013-T1-v1",
        measurements: Map<String, Any>,
        notes: String?
    ): LocalRecord {
        val record = LocalRecord(
            localId = UUID.randomUUID().toString(),
            projectId = projectId,
            projectCode = projectCode,
            activityDate = activityDate,
            areaHa = areaHa,
            ecosystemType = ecosystemType,
            methodologyVersion = methodologyVersion,
            measurementsJson = gson.toJson(measurements),
            notes = notes,
            syncStatus = "LOCAL_DRAFT"
        )
        recordDao.insertRecord(record)
        return record
    }

    suspend fun queueForSync(localId: String) {
        recordDao.updateSyncStatus(localId, "SYNC_PENDING", null)
    }

    suspend fun getRecordById(localId: String): LocalRecord? = recordDao.getRecordById(localId)
}
