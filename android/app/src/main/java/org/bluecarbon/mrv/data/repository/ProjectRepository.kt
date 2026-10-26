package org.bluecarbon.mrv.data.repository

import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import org.bluecarbon.mrv.data.api.MrvApiService
import org.bluecarbon.mrv.data.db.LocalProject
import org.bluecarbon.mrv.data.db.ProjectDao

class ProjectRepository(
    private val projectDao: ProjectDao,
    private val apiService: MrvApiService,
    private val gson: Gson
) {
    val projects: Flow<List<LocalProject>> = projectDao.getAllProjects()

    suspend fun refreshProjects(): Result<Unit> {
        return try {
            val response = apiService.getProjects()
            if (response.isSuccessful && response.body() != null) {
                val dtos = response.body()!!.projects
                val entities = dtos.map { dto ->
                    LocalProject(
                        id = dto.id,
                        code = dto.code,
                        name = dto.name,
                        ecosystemType = dto.ecosystemType,
                        climateRegion = dto.climateRegion,
                        boundaryGeoJson = dto.boundaryGeoJson?.let { gson.toJson(it) },
                        status = dto.status
                    )
                }
                projectDao.insertProjects(entities)
                Result.success(Unit)
            } else {
                Result.failure(Exception("Failed to fetch projects (HTTP ${response.code()})"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getProjectById(id: String): LocalProject? = projectDao.getProjectById(id)
}
