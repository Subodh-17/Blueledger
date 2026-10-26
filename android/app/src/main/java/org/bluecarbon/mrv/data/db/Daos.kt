package org.bluecarbon.mrv.data.db

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    @Query("SELECT * FROM local_projects ORDER BY name ASC")
    fun getAllProjects(): Flow<List<LocalProject>>

    @Query("SELECT * FROM local_projects WHERE id = :id")
    suspend fun getProjectById(id: String): LocalProject?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertProjects(projects: List<LocalProject>)

    @Query("DELETE FROM local_projects")
    suspend fun clearProjects()
}

@Dao
interface RecordDao {
    @Query("SELECT * FROM local_records ORDER BY createdAt DESC")
    fun getAllRecords(): Flow<List<LocalRecord>>

    @Query("SELECT * FROM local_records WHERE localId = :localId")
    suspend fun getRecordById(localId: String): LocalRecord?

    @Query("SELECT * FROM local_records WHERE syncStatus = 'SYNC_PENDING' ORDER BY createdAt ASC")
    suspend fun getPendingRecords(): List<LocalRecord>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRecord(record: LocalRecord)

    @Update
    suspend fun updateRecord(record: LocalRecord)

    @Query("UPDATE local_records SET syncStatus = :status, remoteId = :remoteId, updatedAt = :timestamp WHERE localId = :localId")
    suspend fun updateSyncStatus(localId: String, status: String, remoteId: String?, timestamp: Long = System.currentTimeMillis())

    @Delete
    suspend fun deleteRecord(record: LocalRecord)
}

@Dao
interface EvidenceDao {
    @Query("SELECT * FROM local_evidence_queue WHERE localRecordId = :localRecordId")
    fun getEvidenceForRecord(localRecordId: String): Flow<List<LocalEvidence>>

    @Query("SELECT * FROM local_evidence_queue WHERE syncStatus = 'PENDING_UPLOAD' ORDER BY createdAt ASC")
    suspend fun getPendingEvidence(): List<LocalEvidence>

    @Query("SELECT COUNT(*) FROM local_evidence_queue WHERE localRecordId = :localRecordId AND syncStatus != 'UPLOADED'")
    suspend fun getUnsyncedEvidenceCount(localRecordId: String): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEvidence(evidence: LocalEvidence)

    @Update
    suspend fun updateEvidence(evidence: LocalEvidence)

    @Query("UPDATE local_evidence_queue SET syncStatus = :status, remoteEvidenceId = :remoteId, ipfsCid = :cid, scanStatus = :scanStatus WHERE id = :id")
    suspend fun markUploaded(id: String, status: String, remoteId: String?, cid: String?, scanStatus: String?)

    @Query("UPDATE local_evidence_queue SET syncStatus = 'PENDING_UPLOAD', retryCount = retryCount + 1, lastError = :error WHERE id = :id")
    suspend fun markRetry(id: String, error: String)

    @Delete
    suspend fun deleteEvidence(evidence: LocalEvidence)
}

@Dao
interface SyncTransactionDao {
    @Query("SELECT * FROM sync_transactions WHERE idempotencyKey = :key")
    suspend fun getTransaction(key: String): SyncTransaction?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun recordTransaction(transaction: SyncTransaction)
}
