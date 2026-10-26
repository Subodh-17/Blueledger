package org.bluecarbon.mrv.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import org.bluecarbon.mrv.BlueCarbonApp
import org.bluecarbon.mrv.ui.screens.*
import org.bluecarbon.mrv.ui.theme.BlueCarbonMRVTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as BlueCarbonApp

        setContent {
            BlueCarbonMRVTheme {
                val navController = rememberNavController()
                val authRepo = app.authRepository
                val projectRepo = app.projectRepository
                val recordRepo = app.recordRepository
                val evidenceRepo = app.evidenceRepository

                val startDestination = if (authRepo.isLoggedIn) "projects" else "login"

                NavHost(navController = navController, startDestination = startDestination) {
                    composable("login") {
                        LoginScreen(
                            authRepo = authRepo,
                            onLoginSuccess = {
                                navController.navigate("projects") {
                                    popUpTo("login") { inclusive = true }
                                }
                            }
                        )
                    }

                    composable("projects") {
                        ProjectListScreen(
                            projectRepo = projectRepo,
                            onProjectSelected = { pId, pCode ->
                                navController.navigate("record_create/$pId/$pCode")
                            },
                            onViewSyncQueue = {
                                navController.navigate("sync_queue")
                            }
                        )
                    }

                    composable(
                        route = "record_create/{projectId}/{projectCode}",
                        arguments = listOf(
                            navArgument("projectId") { type = NavType.StringType },
                            navArgument("projectCode") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val pId = backStackEntry.arguments?.getString("projectId") ?: ""
                        val pCode = backStackEntry.arguments?.getString("projectCode") ?: ""

                        RecordCreateScreen(
                            projectId = pId,
                            projectCode = pCode,
                            recordRepo = recordRepo,
                            onNavigateBack = { navController.popBackStack() },
                            onAttachEvidence = { localRecordId ->
                                navController.navigate("evidence_capture/$localRecordId")
                            }
                        )
                    }

                    composable(
                        route = "evidence_capture/{localRecordId}",
                        arguments = listOf(
                            navArgument("localRecordId") { type = NavType.StringType }
                        )
                    ) { backStackEntry ->
                        val rId = backStackEntry.arguments?.getString("localRecordId") ?: ""

                        EvidenceCaptureScreen(
                            localRecordId = rId,
                            recordRepo = recordRepo,
                            evidenceRepo = evidenceRepo,
                            onNavigateBack = { navController.popBackStack() },
                            onQueueForSync = {
                                navController.navigate("sync_queue") {
                                    popUpTo("projects") { inclusive = false }
                                }
                            }
                        )
                    }

                    composable("sync_queue") {
                        SyncStatusScreen(
                            recordRepo = recordRepo,
                            onNavigateBack = { navController.popBackStack() }
                        )
                    }
                }
            }
        }
    }
}
