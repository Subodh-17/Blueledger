package org.bluecarbon.mrv.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.bluecarbon.mrv.data.repository.RecordRepository
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordCreateScreen(
    projectId: String,
    projectCode: String,
    recordRepo: RecordRepository,
    onNavigateBack: () -> Unit,
    onAttachEvidence: (String) -> Unit
) {
    val today = remember {
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    }

    var activityDate by remember { mutableStateOf(today) }
    var areaHaText by remember { mutableStateOf("10.0") }
    var ecosystemType by remember { mutableStateOf("MANGROVE") }
    var canopyCoverText by remember { mutableStateOf("45.0") }
    var seedlingsText by remember { mutableStateOf("5000") }
    var notes by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New Plot Survey ($projectCode)") },
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
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            OutlinedTextField(
                value = activityDate,
                onValueChange = { activityDate = it },
                label = { Text("Activity Date (YYYY-MM-DD)") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = areaHaText,
                onValueChange = { areaHaText = it },
                label = { Text("Area (Hectares)") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = ecosystemType,
                onValueChange = { ecosystemType = it },
                label = { Text("Ecosystem (MANGROVE, SEAGRASS, SALT_MARSH)") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = canopyCoverText,
                onValueChange = { canopyCoverText = it },
                label = { Text("Canopy Cover % (e.g. 45.0)") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = seedlingsText,
                onValueChange = { seedlingsText = it },
                label = { Text("Seedlings Planted / Density Count") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it },
                label = { Text("Field Notes & Plot Observations") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3
            )

            if (errorMessage != null) {
                Text(
                    text = errorMessage!!,
                    color = MaterialTheme.colorScheme.error
                )
            }

            Button(
                onClick = {
                    val area = areaHaText.toDoubleOrNull()
                    val canopy = canopyCoverText.toDoubleOrNull()
                    val seedlings = seedlingsText.toIntOrNull()

                    if (area == null || area <= 0.0) {
                        errorMessage = "Area must be a positive number of hectares"
                        return@Button
                    }
                    if (canopy == null || canopy !in 0.0..100.0) {
                        errorMessage = "Canopy cover must be between 0% and 100%"
                        return@Button
                    }

                    errorMessage = null
                    scope.launch {
                        val measurements = mutableMapOf<String, Any>(
                            "canopy_cover_pct" to canopy
                        )
                        if (seedlings != null) measurements["seedlings_planted"] = seedlings

                        val draft = recordRepo.createDraft(
                            projectId = projectId,
                            projectCode = projectCode,
                            activityDate = activityDate.trim(),
                            areaHa = area,
                            ecosystemType = ecosystemType.trim().uppercase(),
                            methodologyVersion = "IPCC-WS2013-T1-v1",
                            measurements = measurements,
                            notes = notes.trim().ifBlank { null }
                        )

                        onAttachEvidence(draft.localId)
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.CameraAlt, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text("Save Draft & Attach Evidence")
            }
        }
    }
}
