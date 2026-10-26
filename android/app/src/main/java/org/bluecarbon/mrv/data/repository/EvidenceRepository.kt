package org.bluecarbon.mrv.data.repository

import kotlinx.coroutines.flow.Flow
import org.bluecarbon.mrv.data.db.EvidenceDao
import org.bluecarbon.mrv.data.db.LocalEvidence
import org.bluecarbon.mrv.util.CryptoUtils
import java.io.File
import java.util.UUID

class EvidenceRepository(
    private val evidenceDao: EvidenceDao
) {
    fun getEvidenceForRecord(localRecordId: String): Flow<List<LocalEvidence>> =
        evidenceDao.getEvidenceForRecord(localRecordId)

    suspend fun attachEvidence(
        localRecordId: String,
        file: File,
        kind: String = "FIELD_PHOTO",
        captureDate: String,
        latitude: Double,
        longitude: Double,
        accuracyMeters: Float
    ): LocalEvidence {
        val sha = CryptoUtils.sha256(file)
        val evidence = LocalEvidence(
            id = UUID.randomUUID().toString(),
            localRecordId = localRecordId,
            filePath = file.absolutePath,
            fileName = file.name,
            mimeType = if (file.name.endsWith(".png", true)) "image/png" else "image/jpeg",
            sha256 = sha,
            kind = kind,
            latitude = latitude,
            longitude = longitude,
            accuracyMeters = accuracyMeters,
            captureDate = captureDate,
            syncStatus = "PENDING_UPLOAD"
        )
        evidenceDao.insertEvidence(evidence)
        return evidence
    }
}
