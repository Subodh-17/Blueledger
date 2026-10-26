package org.bluecarbon.mrv.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.bluecarbon.mrv.data.db.LocalProject
import org.bluecarbon.mrv.data.repository.ProjectRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectListScreen(
    projectRepo: ProjectRepository,
    onProjectSelected: (String, String) -> Unit,
    onViewSyncQueue: () -> Unit
) {
    val projects by projectRepo.projects.collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var isRefreshing by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Assigned Projects") },
                actions = {
                    IconButton(onClick = onViewSyncQueue) {
                        Icon(Icons.Default.CloudSync, contentDescription = "Sync Queue")
                    }
                    IconButton(onClick = {
                        isRefreshing = true
                        scope.launch {
                            projectRepo.refreshProjects()
                            isRefreshing = false
                        }
                    }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                }
            )
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (projects.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("No local projects cached.")
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(onClick = {
                        isRefreshing = true
                        scope.launch {
                            projectRepo.refreshProjects()
                            isRefreshing = false
                        }
                    }) {
                        Text("Fetch Projects from Server")
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(projects) { project ->
                        ProjectCard(project = project, onSelect = {
                            onProjectSelected(project.id, project.code)
                        })
                    }
                }
            }

            if (isRefreshing) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center)
                )
            }
        }
    }
}

@Composable
fun ProjectCard(
    project: LocalProject,
    onSelect: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onSelect() },
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = project.name,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp
                )
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Text(
                        text = project.ecosystemType,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = "Code: ${project.code}",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
            if (project.climateRegion != null) {
                Text(
                    text = "Region: ${project.climateRegion}",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                )
            }
        }
    }
}
