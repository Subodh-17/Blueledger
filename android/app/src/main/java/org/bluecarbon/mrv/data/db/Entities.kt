package org.bluecarbon.mrv.data.db

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "local_projects")
data class LocalProject(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
    val ecosystemType: String,
    val climateRegion: String?,
    val boundaryGeoJson: String?,
    val status: String,
    val cachedAt: Long = System.currentTimeMillis()
)

@Entity(
    tableName = "local_records",
    foreignKeys = [
        ForeignKey(
            entity = LocalProject::class,
            parentColumns = ["id"],
            childColumns = ["projectId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("projectId")]
)
data class LocalRecord(
    @PrimaryKey val localId: String,
    val remoteId: String? = null,
    val projectId: String,
    val projectCode: String,
    val activityDate: String,
    val areaHa: Double,
    val ecosystemType: String,
    val methodologyVersion: String,
    val measurementsJson: String,
    val notes: String?,
    val syncStatus: String, // 'LOCAL_DRAFT', 'SYNC_PENDING', 'SYNCED', 'SYNC_FAILED'
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

@Entity(
    tableName = "local_evidence_queue",
    foreignKeys = [
        ForeignKey(
            entity = LocalRecord::class,
            parentColumns = ["localId"],
            childColumns = ["localRecordId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("localRecordId")]
)
data class LocalEvidence(
    @PrimaryKey val id: String,
    val localRecordId: String,
    val filePath: String,
    val fileName: String,
    val mimeType: String,
    val sha256: String,
    val kind: String,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val captureDate: String,
    val syncStatus: String, // 'PENDING_UPLOAD', 'UPLOADING', 'UPLOADED', 'REJECTED'
    val remoteEvidenceId: String? = null,
    val ipfsCid: String? = null,
    val scanStatus: String? = null,
    val retryCount: Int = 0,
    val lastError: String? = null,
    val createdAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "sync_transactions")
data class SyncTransaction(
    @PrimaryKey val idempotencyKey: String,
    val operationType: String,
    val payloadHash: String,
    val syncedAt: Long = System.currentTimeMillis()
)
