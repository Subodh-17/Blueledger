package org.bluecarbon.mrv.util

import android.location.Location
import android.os.Build

data class GpsReading(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val isMock: Boolean,
    val timestamp: Long
) {
    val isAcceptable: Boolean
        get() = !isMock && accuracyMeters <= 15.0f && latitude in -90.0..90.0 && longitude in -180.0..180.0
}

object LocationHelper {

    fun isMock(location: Location): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            location.isMock
        } else {
            @Suppress("DEPRECATION")
            location.isFromMockProvider
        }
    }

    fun parseReading(location: Location): GpsReading {
        return GpsReading(
            latitude = location.latitude,
            longitude = location.longitude,
            accuracyMeters = location.accuracy,
            isMock = isMock(location),
            timestamp = location.time
        )
    }
}
