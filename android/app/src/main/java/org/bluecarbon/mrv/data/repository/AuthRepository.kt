package org.bluecarbon.mrv.data.repository

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.bluecarbon.mrv.data.api.LoginRequest
import org.bluecarbon.mrv.data.api.MrvApiService
import org.bluecarbon.mrv.data.api.UserDto

class AuthRepository(
    context: Context,
    private val apiService: MrvApiService
) {
    private val prefs: SharedPreferences

    private val _currentUser = MutableStateFlow<UserDto?>(null)
    val currentUser: StateFlow<UserDto?> = _currentUser.asStateFlow()

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = try {
            EncryptedSharedPreferences.create(
                context,
                "mrv_secure_auth_prefs",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            context.getSharedPreferences("mrv_fallback_auth_prefs", Context.MODE_PRIVATE)
        }

        val token = prefs.getString("jwt_token", null)
        val email = prefs.getString("user_email", null)
        val name = prefs.getString("user_name", null)
        val role = prefs.getString("user_role", null)
        val id = prefs.getString("user_id", null)
        val orgId = prefs.getString("user_org_id", null)

        if (!token.isNullOrBlank() && !id.isNullOrBlank() && !email.isNullOrBlank()) {
            _currentUser.value = UserDto(id = id, email = email, name = name ?: "", role = role ?: "FIELD", organizationId = orgId)
        }
    }

    fun getToken(): String? = prefs.getString("jwt_token", null)

    val isLoggedIn: Boolean
        get() = !getToken().isNullOrBlank()

    suspend fun login(email: String, pass: String): Result<UserDto> {
        return try {
            val res = apiService.login(LoginRequest(email.trim(), pass))
            if (res.isSuccessful && res.body() != null) {
                val body = res.body()!!
                prefs.edit()
                    .putString("jwt_token", body.token)
                    .putString("user_id", body.user.id)
                    .putString("user_email", body.user.email)
                    .putString("user_name", body.user.name)
                    .putString("user_role", body.user.role)
                    .putString("user_org_id", body.user.organizationId)
                    .apply()
                _currentUser.value = body.user
                Result.success(body.user)
            } else {
                Result.failure(Exception("Authentication failed (HTTP ${res.code()})"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun logout() {
        prefs.edit().clear().apply()
        _currentUser.value = null
    }
}
