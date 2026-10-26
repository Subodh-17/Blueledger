package org.bluecarbon.mrv.data.api

import com.google.gson.annotations.SerializedName

// ── Auth Models ─────────────────────────────────────────────────────────────
data class LoginRequest(
    val email: String,
    val password: String
)

data class LoginResponse(
    val token: String,
    val user: UserDto
)

data class UserDto(
    val id: String,
    val email: String,
    val name: String,
    val role: String,
    @SerializedName("organization_id") val organizationId: String?
)

// ── Project Models ──────────────────────────────────────────────────────────
data class ProjectListResponse(
    val projects: List<ProjectDto>
)

data class ProjectDto(
    val id: String,
    val code: String,
    val name: String,
    @SerializedName("ecosystem_type") val ecosystemType: String,
    @SerializedName("climate_region") val climateRegion: String?,
    @SerializedName("boundary_geojson") val boundaryGeoJson: Any?,
    val status: String
)

// ── Record Models ───────────────────────────────────────────────────────────
data class CreateRecordRequest(
    val projectId: String,
    val activityDate: String,
    val areaHa: Double,
    val ecosystemType: String,
    val methodologyVersion: String,
    val measurements: Map<String, Any>,
    val notes: String?
)

data class RecordResponse(
    val record: RecordDto
)

data class RecordDto(
    val id: String,
    @SerializedName("project_id") val projectId: String,
    val code: String?,
    val status: String,
    @SerializedName("activity_date") val activityDate: String,
    @SerializedName("area_ha") val areaHa: Double
)

data class SubmitRecordResponse(
    val record: RecordDto,
    val message: String?
)

// ── Evidence Models ─────────────────────────────────────────────────────────
data class EvidenceUploadResponse(
    val evidence: EvidenceDto
)

data class EvidenceDto(
    val id: String,
    @SerializedName("project_id") val projectId: String,
    @SerializedName("record_id") val recordId: String,
    val kind: String,
    val sha256: String,
    @SerializedName("ipfs_cid") val ipfsCid: String?,
    @SerializedName("ipfs_status") val ipfsStatus: String,
    @SerializedName("scan_status") val scanStatus: String?
)
