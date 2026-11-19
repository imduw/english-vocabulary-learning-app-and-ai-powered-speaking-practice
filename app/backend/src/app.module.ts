import { Module } from '@nestjs/common';
import { readConfig } from './config';
import { APP_CONFIG, DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { SupabaseAuthService } from './auth/supabase-auth.service';
import { AuthGuard } from './auth/auth.guard';
import { ProfilesController } from './profiles/profiles.controller';
import { ProfilesRepository } from './profiles/profiles.repository';
import { DecksController, VocabularyController } from './learning/learning.controller';
import { LearningService } from './learning/learning.service';
import { LearningRepository } from './learning/learning.repository';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';
import { ProgressController } from './progress/progress.controller';
import { ProgressService, PROGRESS_CLOCK } from './progress/progress.service';
import { OcrController, OcrUploadErrors } from './ocr/ocr.controller';
import { OcrBudget, OcrRequestGuard } from './ocr/ocr-budget';
import { OcrEngine } from './ocr/ocr-engine';
import { OcrImageProcessor } from './ocr/ocr-image';
import { OcrService } from './ocr/ocr.service';
import { AuthController } from './auth/auth.controller';
import { AuthSessionService } from './auth/auth-session.service';
import { AuthRateGuard } from './auth/auth-rate.guard';

@Module({
  controllers: [HealthController, ProfilesController, DecksController, VocabularyController, SyncController, ProgressController, OcrController, AuthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => readConfig() },
    DatabaseService, HealthService,
    SupabaseAuthService, AuthGuard, ProfilesRepository,
    AuthSessionService, AuthRateGuard,
    LearningService, LearningRepository,
    SyncService,
    ProgressService, {provide:PROGRESS_CLOCK,useValue:()=>new Date()},
    OcrBudget, OcrRequestGuard, OcrUploadErrors, OcrEngine, OcrImageProcessor, OcrService,
  ],
})
export class AppModule {}
