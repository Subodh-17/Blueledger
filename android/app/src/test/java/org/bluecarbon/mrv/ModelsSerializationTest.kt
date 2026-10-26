package org.bluecarbon.mrv

import com.google.gson.Gson
import org.bluecarbon.mrv.data.api.CreateRecordRequest
import org.bluecarbon.mrv.data.api.LoginRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsSerializationTest {

    private val gson = Gson()

    @Test
    fun loginRequest_serializesCorrectly() {
        val req = LoginRequest("field@example.com", "Password123!")
        val json = gson.toJson(req)
        assertTrue(json.contains("\"email\":\"field@example.com\""))
        assertTrue(json.contains("\"password\":\"Password123!\""))
    }

    @Test
    fun createRecordRequest_serializesMeasurementsProperly() {
        val req = CreateRecordRequest(
            projectId = "p-1234",
            activityDate = "2026-10-26",
            areaHa = 15.5,
            ecosystemType = "MANGROVE",
            methodologyVersion = "IPCC-WS2013-T1-v1",
            measurements = mapOf("canopy_cover_pct" to 52.0, "seedlings_planted" to 1000),
            notes = "Test survey"
        )
        val json = gson.toJson(req)
        assertTrue(json.contains("\"projectId\":\"p-1234\""))
        assertTrue(json.contains("\"canopy_cover_pct\":52.0"))
        assertTrue(json.contains("\"methodologyVersion\":\"IPCC-WS2013-T1-v1\""))
    }
}
