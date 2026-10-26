package org.bluecarbon.mrv

import org.bluecarbon.mrv.util.GpsReading
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationHelperTest {

    @Test
    fun gpsReading_acceptableWhenWithinAccuracyBoundsAndReal() {
        val reading = GpsReading(
            latitude = 21.9497,
            longitude = 89.1833,
            accuracyMeters = 8.5f,
            isMock = false,
            timestamp = System.currentTimeMillis()
        )
        assertTrue(reading.isAcceptable)
    }

    @Test
    fun gpsReading_unacceptableWhenMockLocation() {
        val reading = GpsReading(
            latitude = 21.9497,
            longitude = 89.1833,
            accuracyMeters = 3.0f,
            isMock = true,
            timestamp = System.currentTimeMillis()
        )
        assertFalse(reading.isAcceptable)
    }

    @Test
    fun gpsReading_unacceptableWhenInaccurate() {
        val reading = GpsReading(
            latitude = 21.9497,
            longitude = 89.1833,
            accuracyMeters = 25.0f,
            isMock = false,
            timestamp = System.currentTimeMillis()
        )
        assertFalse(reading.isAcceptable)
    }
}
