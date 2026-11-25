import os
import secrets
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "PetroBlend Enterprise ERP"
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./data/lubricants_erp.db")
    JWT_SECRET: str = os.getenv("JWT_SECRET") or secrets.token_hex(32)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_HOURS: int = 12
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "./uploads")
    BACKUP_DIR: str = os.getenv("BACKUP_DIR", "./backups")
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
