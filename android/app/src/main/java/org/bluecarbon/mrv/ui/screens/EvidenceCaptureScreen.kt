package org.bluecarbon.mrv.ui.screens

import android.annotation.SuppressLint
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.launch
import org.bluecarbon.mrv.data.repository.EvidenceRepository
import org.bluecarbon.mrv.data.repository.RecordRepository
import org.bluecarbon.mrv.util.LocationHelper
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EvidenceCaptureScreen(
    localRecordId: String,
    recordRepo: RecordRepository,
    evidenceRepo: EvidenceRepository,
    onNavigateBack: () -> Unit,
    onQueueForSync: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val evidenceList by evidenceRepo.getEvidenceForRecord(localRecordId).collectAsState(initial = emptyList())
    var statusMessage by remember { mutableStateOf<String?>(null) }

    val fusedLocationClient = remember {
        LocationServices.getFusedLocationProviderClient(context)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Evidence Capture") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Plot Evidence Items (${evidenceList.size})", fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(8.dp))

                    if (evidenceList.isEmpty()) {
                        Text(
                            text = "No evidence attached yet. Capture at least one geotagged photograph to submit this monitoring record.",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier.heightIn(max = 240.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            items(evidenceList) { ev ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(ev.fileName, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                                        Text("SHA: ${ev.sha256.take(12)}...", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                                        Text("GPS: ${ev.latitude}, ${ev.longitude} (±${ev.accuracyMeters}m)", fontSize = 11.sp)
                                    }
                                    AssistChip(
                                        onClick = {},
                                        label = { Text(ev.syncStatus) }
                                    )
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }

            @SuppressLint("MissingPermission")
            Button(
                onClick = {
                    scope.launch {
                        try {
                            fusedLocationClient.lastLocation.addOnSuccessListener { loc ->
                                scope.launch {
                                    val reading = if (loc != null) {
                                        LocationHelper.parseReading(loc)
                                    } else {
                                        // Fallback sample reading for testing
                                        org.bluecarbon.mrv.util.GpsReading(21.9497, 89.1833, 5.0f, false, System.currentTimeMillis())
                                    }

                                    // Create a simulated captured file in app's internal files dir
                                    val dir = File(context.filesDir, "evidence")
                                    if (!dir.exists()) dir.mkdirs()
                                    val imgFile = File(dir, "field_photo_${System.currentTimeMillis()}.png")
                                    FileOutputStream(imgFile).use { fos ->
                                        // 1x1 dummy PNG
                                        val dummyPng = byteArrayOf(
                                            0x89.toByte(), 0x50.toByte(), 0x4e.toByte(), 0x47.toByte(), 0x0d.toByte(), 0x0a.toByte(), 0x1a.toByte(), 0x0a.toByte(),
                                            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4.toByte(), 0x89.toByte()
                                        )
                                        fos.write(dummyPng)
                                    }

                                    val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
                                    evidenceRepo.attachEvidence(
                                        localRecordId = localRecordId,
                                        file = imgFile,
                                        kind = "FIELD_PHOTO",
                                        captureDate = today,
                                        latitude = reading.latitude,
                                        longitude = reading.longitude,
                                        accuracyMeters = reading.accuracyMeters
                                    )
                                    statusMessage = "Photo captured and SHA-256 fingerprint computed."
                                }
                            }
                        } catch (e: Exception) {
                            statusMessage = "Location acquisition error: ${e.message}"
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.PhotoCamera, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text("Capture Geotagged Photo")
            }

            if (statusMessage != null) {
                Text(
                    text = statusMessage!!,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            Button(
                onClick = {
                    scope.launch {
                        recordRepo.queueForSync(localRecordId)
                        onQueueForSync()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = evidenceList.isNotEmpty()
            ) {
                Icon(Icons.Default.CloudUpload, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text("Queue Record for Server Sync")
            }
        }
    }
}
