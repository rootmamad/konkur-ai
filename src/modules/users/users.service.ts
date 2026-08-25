import { Injectable,ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {CreateUserDto} from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {} 

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }

  async findByNationalId(nationalId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ nationalId }).exec();
  }

  async findByPhoneNumberWithPassword(
  phoneNumber: string,
   ): Promise<UserDocument | null> {
  return this.userModel
    .findOne({ phoneNumber })
    .select('+passwordHash')
    .exec();
}


  async findByPhoneNumber(
    phoneNumber: string,
  ): Promise<UserDocument | null> {
    return this.userModel.findOne({ phoneNumber }).exec();
  }
  async create(data: CreateUserDto): Promise<UserDocument> {
  const passwordHash = await bcrypt.hash(data.nationalId, 12);
    try{
    const user = new this.userModel({
    ...data,
    passwordHash: passwordHash,
  });

  return await user.save();} catch(error) {
    if (error?.code === 11000) {
      throw new ConflictException(
        'National ID or phone number already exists',
      );
    }
      throw error;
  }
}
}
