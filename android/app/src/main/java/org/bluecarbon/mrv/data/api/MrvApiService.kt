package org.bluecarbon.mrv.data.api

import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

interface MrvApiService {

    @POST("api/auth/login")
    suspend fun login(
        @Body request: LoginRequest
    ): Response<LoginResponse>

    @GET("api/projects")
    suspend fun getProjects(): Response<ProjectListResponse>

    @POST("api/records")
    suspend fun createRecord(
        @Header("X-Idempotency-Key") idempotencyKey: String,
        @Body request: CreateRecordRequest
    ): Response<RecordResponse>

    @Multipart
    @POST("api/evidence")
    suspend fun uploadEvidence(
        @Part file: MultipartBody.Part,
        @Part("projectId") projectId: RequestBody,
        @Part("recordId") recordId: RequestBody,
        @Part("kind") kind: RequestBody,
        @Part("captureDate") captureDate: RequestBody,
        @Part("sha256") sha256: RequestBody,
        @Part("latitude") latitude: RequestBody?,
        @Part("longitude") longitude: RequestBody?,
        @Part("accuracyMeters") accuracyMeters: RequestBody?
    ): Response<EvidenceUploadResponse>

    @POST("api/records/{id}/submit")
    suspend fun submitRecord(
        @Path("id") recordId: String
    ): Response<SubmitRecordResponse>

    @GET("health")
    suspend fun checkHealth(): Response<Map<String, Any>>
}
